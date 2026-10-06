import { updateSubscriptionMode } from '@/api/subscriptions/api.subscriptions.db';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '@/entities/ISubscription';
import { sendDiscordUpdate } from '@/notifier-discord';
import { sqlExecutor } from '@/sql-executor';
import { markSubscriptionCoverageDirty } from '@/subscription-coverage/subscription-coverage-dirty';
import { sendSubscriptionTopUpWaveUpdate } from '@/subscription-wave-notifier';
import { invalidateUpcomingSubscriptionCaches } from '@/subscriptionsDaily/subscription-cache';
import { persistTopUps } from './db.subscriptions_topup';

jest.mock('@/api/subscriptions/api.subscriptions.db', () => ({
  updateSubscriptionMode: jest.fn()
}));
jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/sql-executor', () => ({
  sqlExecutor: { executeNativeQueriesInTransaction: jest.fn() }
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn(), error: jest.fn() }) }
}));
jest.mock('@/eth-tools', () => ({
  ethTools: { toEtherScanTransactionLink: jest.fn().mockReturnValue('tx-link') }
}));
jest.mock('@/notifier-discord', () => ({ sendDiscordUpdate: jest.fn() }));
jest.mock('@/subscription-wave-notifier', () => ({
  sendProcessedTopUpWaveWarning: jest.fn(),
  sendSubscriptionTopUpWaveUpdate: jest.fn()
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirty: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

const balancesRepo = { findOne: jest.fn(), save: jest.fn() };
const topUpsRepo = { save: jest.fn() };
const manager = {
  query: jest.fn(),
  getRepository: jest.fn(
    (entity: typeof SubscriptionBalance | typeof SubscriptionTopUp) =>
      entity === SubscriptionBalance ? balancesRepo : topUpsRepo
  ),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getExists: jest.fn().mockResolvedValue(false)
  }))
};
const connection = { connection: { manager } };
const topUp: SubscriptionTopUp = {
  hash: 'top-up',
  block: 1,
  transaction_date: new Date('2026-10-06T00:00:00Z'),
  from_wallet: 'wallet',
  amount: 1
};
let events: string[];

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  manager.query.mockResolvedValue([{ consolidation_key: 'wallet' }]);
  balancesRepo.findOne.mockResolvedValue(null);
  jest.mocked(updateSubscriptionMode).mockReset().mockResolvedValue({
    consolidation_key: 'wallet',
    automatic: true
  });
  (
    sqlExecutor.executeNativeQueriesInTransaction as jest.Mock
  ).mockImplementation(
    async (execute: (holder: typeof connection) => Promise<void>) => {
      try {
        await execute(connection);
        events.push('commit');
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    }
  );
  jest
    .mocked(invalidateUpcomingSubscriptionCaches)
    .mockImplementation(async () => {
      events.push('evict');
    });
});

it('rejects the transaction after a mode/quantity synchronization lock timeout, without post-commit effects', async () => {
  const lockTimeout = Object.assign(new Error('Lock wait timeout exceeded'), {
    code: 'ER_LOCK_WAIT_TIMEOUT'
  });
  jest.mocked(updateSubscriptionMode).mockRejectedValueOnce(lockTimeout);

  await expect(persistTopUps([topUp])).rejects.toBe(lockTimeout);

  expect(balancesRepo.save).toHaveBeenCalled();
  expect(topUpsRepo.save).toHaveBeenCalledWith(topUp);
  expect(updateSubscriptionMode).toHaveBeenCalledWith(
    'wallet',
    true,
    connection
  );
  expect(events).toEqual(['rollback']);
  expect(invalidateUpcomingSubscriptionCaches).not.toHaveBeenCalled();
  expect(markSubscriptionCoverageDirty).not.toHaveBeenCalled();
  expect(sendDiscordUpdate).not.toHaveBeenCalled();
  expect(sendSubscriptionTopUpWaveUpdate).not.toHaveBeenCalled();
});

it('evicts and schedules coverage only after successful top-up and mode synchronization commit', async () => {
  await persistTopUps([topUp]);

  expect(updateSubscriptionMode).toHaveBeenCalledWith(
    'wallet',
    true,
    connection
  );
  expect(events).toEqual(['commit', 'evict']);
  expect(markSubscriptionCoverageDirty).toHaveBeenCalledWith(
    ['wallet'],
    'BALANCE_TOPPED_UP'
  );
  expect(sendDiscordUpdate).toHaveBeenCalledTimes(1);
  expect(sendSubscriptionTopUpWaveUpdate).toHaveBeenCalledTimes(1);
});
