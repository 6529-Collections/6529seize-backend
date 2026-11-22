import { updateSubscriptionMode } from '@/api/subscriptions/api.subscriptions.db';
import { InsufficientSubscriptionBalanceException } from '@/api/subscriptions/insufficient-subscription-balance.exception';
import { MEMES_MINT_PRICE } from '@/constants';
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
  sqlExecutor: {
    executeNativeQueriesInTransaction: jest.fn(),
    execute: jest.fn()
  }
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      errorWithCode: jest.fn()
    })
  }
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

describe('first top-up for a consolidation without a balance', () => {
  it('keeps the current mode and commits when the top-up is below the mint price', async () => {
    const small = { ...topUp, amount: MEMES_MINT_PRICE / 2 };

    await persistTopUps([small]);

    expect(updateSubscriptionMode).not.toHaveBeenCalled();
    expect(balancesRepo.save).toHaveBeenCalledWith({
      consolidation_key: 'wallet',
      balance: MEMES_MINT_PRICE / 2
    });
    expect(topUpsRepo.save).toHaveBeenCalledWith(small);
    expect(events).toEqual(['commit', 'evict']);
    expect(sendDiscordUpdate).toHaveBeenCalledTimes(1);
  });

  it('switches to automatic mode when the top-up equals the mint price', async () => {
    const exact = { ...topUp, amount: MEMES_MINT_PRICE };

    await persistTopUps([exact]);

    expect(updateSubscriptionMode).toHaveBeenCalledWith(
      'wallet',
      true,
      connection
    );
    expect(events).toEqual(['commit', 'evict']);
  });

  it('treats an insufficient balance answer as a skip, not a rollback', async () => {
    jest
      .mocked(updateSubscriptionMode)
      .mockRejectedValueOnce(new InsufficientSubscriptionBalanceException());

    await persistTopUps([{ ...topUp, amount: MEMES_MINT_PRICE }]);

    expect(events).toEqual(['commit', 'evict']);
    expect(sendDiscordUpdate).toHaveBeenCalledTimes(1);
  });

  it('still rolls back on a lock timeout for a top-up at the mint price', async () => {
    const lockTimeout = Object.assign(new Error('Lock wait timeout exceeded'), {
      code: 'ER_LOCK_WAIT_TIMEOUT'
    });
    jest.mocked(updateSubscriptionMode).mockRejectedValueOnce(lockTimeout);

    await expect(
      persistTopUps([{ ...topUp, amount: MEMES_MINT_PRICE }])
    ).rejects.toBe(lockTimeout);
    expect(events).toEqual(['rollback']);
    expect(sendDiscordUpdate).not.toHaveBeenCalled();
  });

  it('does not attempt automatic mode for an existing balance', async () => {
    balancesRepo.findOne.mockResolvedValueOnce({
      consolidation_key: 'wallet',
      balance: 0.01
    });

    await persistTopUps([{ ...topUp, amount: MEMES_MINT_PRICE }]);

    expect(updateSubscriptionMode).not.toHaveBeenCalled();
    expect(events).toEqual(['commit', 'evict']);
  });
});

describe('keys that must wait', () => {
  const longKey = [1, 2, 3, 4, 5]
    .map((n) => `0x${String(n).padStart(40, '0')}`)
    .join('-');
  let claimRows: unknown[];
  let pendingRows: unknown[];

  beforeEach(() => {
    claimRows = [{ replayed_at: null }];
    pendingRows = [];
    jest.mocked(sqlExecutor.execute).mockImplementation((async (
      sql: string
    ) => {
      if (sql.includes('FOR UPDATE')) {
        return claimRows;
      }
      if (sql.includes('replayed_at IS NULL')) {
        return pendingRows;
      }
      // The column widths can't be read here, so every key column counts
      // as the pre-migration 200 characters.
      return undefined;
    }) as never);
  });

  const queued = () =>
    jest
      .mocked(sqlExecutor.execute)
      .mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO subscription_deferred_writes')
      );

  it('queues a top-up whose key a subscription table cannot hold and applies none of it', async () => {
    manager.query.mockResolvedValue([{ consolidation_key: longKey }]);

    await expect(persistTopUps([topUp])).resolves.toBe(true);

    expect(balancesRepo.save).not.toHaveBeenCalled();
    expect(topUpsRepo.save).not.toHaveBeenCalled();
    expect(updateSubscriptionMode).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    expect(queued()[0][1]).toEqual(
      expect.objectContaining({
        p0: 'TOP_UP',
        p1: longKey,
        p3: longKey.length
      })
    );
    expect(queued()[0][2]).toEqual({ wrappedConnection: connection });
    expect(events).toEqual(['commit', 'evict']);
    expect(sendDiscordUpdate).not.toHaveBeenCalled();
    expect(sendSubscriptionTopUpWaveUpdate).not.toHaveBeenCalled();
  });

  it('queues a top-up for a key that fits while the key has earlier writes waiting', async () => {
    pendingRows = [{ sequence: 1 }];

    await persistTopUps([topUp]);

    expect(balancesRepo.save).not.toHaveBeenCalled();
    expect(topUpsRepo.save).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    expect(queued()[0][1]).toEqual(
      expect.objectContaining({ p0: 'TOP_UP', p1: 'wallet' })
    );
  });

  it('replays a queued top-up once: claimed and credited in one transaction', async () => {
    await expect(persistTopUps([topUp], { replaySequence: 7 })).resolves.toBe(
      true
    );

    const calls = jest.mocked(sqlExecutor.execute).mock.calls;
    const claim = calls.findIndex(([sql]) => sql.includes('FOR UPDATE'));
    expect(calls[claim][1]).toEqual({ p0: 7 });
    expect(calls[claim + 1][0]).toContain('SET replayed_at');
    // Only entries queued before this one hold it back.
    const pending = calls.find(([sql]) => sql.includes('replayed_at IS NULL'));
    expect(pending?.[0]).toContain('sequence < ');
    expect(balancesRepo.save).toHaveBeenCalledTimes(1);
    expect(topUpsRepo.save).toHaveBeenCalledWith(topUp);
    expect(events).toEqual(['commit', 'evict']);
  });

  it('makes no write for an entry another run already claimed', async () => {
    claimRows = [{ replayed_at: 5 }];

    await expect(persistTopUps([topUp], { replaySequence: 7 })).resolves.toBe(
      false
    );

    expect(manager.query).not.toHaveBeenCalled();
    expect(balancesRepo.save).not.toHaveBeenCalled();
    expect(topUpsRepo.save).not.toHaveBeenCalled();
    expect(sendDiscordUpdate).not.toHaveBeenCalled();
  });
});
