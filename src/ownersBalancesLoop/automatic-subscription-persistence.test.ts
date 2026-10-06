import { getDataSource } from '@/db';
import {
  synchronizeAutomaticSubscriptionQuantities,
  synchronizeAutomaticSubscriptionQuantitiesAfterReset
} from '@/subscriptionsDaily/subscription-quantity-sync.db';
import { invalidateUpcomingSubscriptionCaches } from '@/subscriptionsDaily/subscription-cache';
import { deleteAll } from '@/orm_helpers';
import { persistConsolidatedOwnerBalances } from './db.owners_balances';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/orm_helpers', () => ({
  deleteAll: jest.fn(),
  deleteConsolidations: jest.fn(),
  insertWithoutUpdate: jest.fn(),
  deleteWallet: jest.fn(),
  resetRepository: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-quantity-sync.db', () => ({
  synchronizeAutomaticSubscriptionQuantities: jest.fn(),
  synchronizeAutomaticSubscriptionQuantitiesAfterReset: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirtyForDemonstratedIntent: jest.fn()
}));

const synchronize = jest.mocked(synchronizeAutomaticSubscriptionQuantities);
const invalidate = jest.mocked(invalidateUpcomingSubscriptionCaches);
const manager = { getRepository: jest.fn(() => ({})) };
let events: string[];

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  (getDataSource as jest.Mock).mockReturnValue({
    transaction: async (fn: (tx: typeof manager) => Promise<string[]>) => {
      const keys = await fn(manager);
      events.push('commit');
      return keys;
    }
  });
  synchronize.mockImplementation(async () => {
    events.push('sync');
    return ['auto'];
  });
  invalidate.mockImplementation(async () => {
    events.push('evict');
  });
});

it('synchronizes inside the balance transaction and evicts only after commit', async () => {
  await persistConsolidatedOwnerBalances([], [], new Set(['auto']), false);
  expect(synchronize).toHaveBeenCalledWith(['auto'], {
    connection: { connection: manager },
    timer: undefined
  });
  expect(events).toEqual(['sync', 'commit', 'evict']);
  expect(invalidate).toHaveBeenCalledWith(['auto']);
});

it('does not evict or publish successful persistence after a failed synchronization', async () => {
  synchronize.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(
    persistConsolidatedOwnerBalances([], [], new Set(['auto']), false)
  ).rejects.toThrow('DB unavailable');
  expect(events).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled();
});

it('commits the balance reset before starting the separately paged quantity reconciliation', async () => {
  jest
    .mocked(synchronizeAutomaticSubscriptionQuantitiesAfterReset)
    .mockImplementation(async () => {
      events.push('reset-sync');
    });
  await persistConsolidatedOwnerBalances([], [], new Set(), true);
  expect(deleteAll).toHaveBeenCalledTimes(2);
  expect(synchronize).not.toHaveBeenCalled();
  expect(
    synchronizeAutomaticSubscriptionQuantitiesAfterReset
  ).toHaveBeenCalledTimes(1);
  expect(invalidate).not.toHaveBeenCalled();
  expect(events).toEqual(['commit', 'reset-sync']);
});
