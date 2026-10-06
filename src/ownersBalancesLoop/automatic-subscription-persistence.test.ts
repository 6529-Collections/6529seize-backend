import { getDataSource } from '@/db';
import {
  synchronizeAutomaticSubscriptionQuantities,
  synchronizeAutomaticSubscriptionQuantitiesAfterReset
} from '@/subscriptionsDaily/subscription-quantity-sync.db';
import { invalidateUpcomingSubscriptionCaches } from '@/subscriptionsDaily/subscription-cache';
import { deleteAll } from '@/orm_helpers';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '@/entities/IOwnerBalances';
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
function mockKeyQuery() {
  return {
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getRawMany: jest.fn<Promise<{ consolidation_key: string }[]>, []>()
  };
}
const balancesKeyQuery = mockKeyQuery();
const memesKeyQuery = mockKeyQuery();
const manager = {
  getRepository: jest.fn(
    (
      entity:
        | typeof ConsolidatedOwnerBalances
        | typeof ConsolidatedOwnerBalancesMemes
    ) => ({
      createQueryBuilder: jest.fn(() =>
        entity === ConsolidatedOwnerBalances ? balancesKeyQuery : memesKeyQuery
      )
    })
  )
};
let events: string[];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(deleteAll).mockReset();
  balancesKeyQuery.getRawMany.mockReset().mockResolvedValue([]);
  memesKeyQuery.getRawMany.mockReset().mockResolvedValue([]);
  jest.mocked(synchronizeAutomaticSubscriptionQuantitiesAfterReset).mockReset();
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

it('evicts manual eligibility responses even when no automatic quantity changes', async () => {
  synchronize.mockResolvedValueOnce([]);
  const balance = new ConsolidatedOwnerBalances();
  balance.consolidation_key = 'manual';
  const memeBalance = new ConsolidatedOwnerBalancesMemes();
  memeBalance.consolidation_key = 'meme-only';
  await persistConsolidatedOwnerBalances(
    [balance],
    [memeBalance],
    new Set(['manual', 'deleted']),
    false
  );
  expect(synchronize).toHaveBeenCalledWith(['manual', 'meme-only', 'deleted'], {
    connection: { connection: manager },
    timer: undefined
  });
  expect(invalidate).toHaveBeenCalledWith(['manual', 'meme-only', 'deleted']);
  expect(events).toEqual(['commit', 'evict']);
});

it('commits the balance reset before starting the separately paged quantity reconciliation', async () => {
  jest
    .mocked(synchronizeAutomaticSubscriptionQuantitiesAfterReset)
    .mockImplementation(async () => {
      events.push('reset-sync');
    });
  await persistConsolidatedOwnerBalances([], [], new Set(['manual']), true);
  expect(deleteAll).toHaveBeenCalledTimes(2);
  expect(synchronize).not.toHaveBeenCalled();
  expect(
    synchronizeAutomaticSubscriptionQuantitiesAfterReset
  ).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith(['manual']);
  expect(events).toEqual(['commit', 'evict', 'reset-sync']);
});

it('evicts committed reset eligibility even when a later quantity page fails', async () => {
  balancesKeyQuery.getRawMany.mockResolvedValueOnce([
    { consolidation_key: 'removed' }
  ]);
  jest
    .mocked(synchronizeAutomaticSubscriptionQuantitiesAfterReset)
    .mockRejectedValueOnce(new Error('page failed'));
  await expect(
    persistConsolidatedOwnerBalances([], [], new Set(['manual']), true)
  ).rejects.toThrow('page failed');
  expect(invalidate).toHaveBeenCalledWith(['manual', 'removed']);
  expect(events).toEqual(['commit', 'evict']);
});

it('captures removed reset keys from both tables before deletion and evicts them after commit', async () => {
  balancesKeyQuery.getRawMany.mockImplementationOnce(async () => {
    events.push('read-balances');
    return [
      { consolidation_key: 'removed' },
      { consolidation_key: 'retained' }
    ];
  });
  memesKeyQuery.getRawMany.mockImplementationOnce(async () => {
    events.push('read-memes');
    return [
      { consolidation_key: 'meme-only-removed' },
      { consolidation_key: 'removed' }
    ];
  });
  jest.mocked(deleteAll).mockImplementation(async () => {
    events.push('delete');
  });
  const balance = new ConsolidatedOwnerBalances();
  balance.consolidation_key = 'retained';
  await persistConsolidatedOwnerBalances([balance], [], new Set(), true);
  for (const query of [balancesKeyQuery, memesKeyQuery]) {
    expect(query.select).toHaveBeenCalledWith(
      'balances.consolidation_key',
      'consolidation_key'
    );
    expect(query.distinct).toHaveBeenCalledWith(true);
  }
  expect(invalidate).toHaveBeenCalledWith([
    'retained',
    'removed',
    'meme-only-removed'
  ]);
  expect(events).toEqual([
    'read-balances',
    'read-memes',
    'delete',
    'delete',
    'commit',
    'evict'
  ]);
  expect(synchronize).not.toHaveBeenCalled();
});

it('does not evict previously persisted keys when the reset transaction fails', async () => {
  balancesKeyQuery.getRawMany.mockResolvedValueOnce([
    { consolidation_key: 'removed' }
  ]);
  jest.mocked(deleteAll).mockRejectedValueOnce(new Error('reset failed'));
  await expect(
    persistConsolidatedOwnerBalances([], [], new Set(), true)
  ).rejects.toThrow('reset failed');
  expect(invalidate).not.toHaveBeenCalled();
  expect(
    synchronizeAutomaticSubscriptionQuantitiesAfterReset
  ).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});
