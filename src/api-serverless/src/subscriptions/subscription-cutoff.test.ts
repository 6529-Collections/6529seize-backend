import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { sqlExecutor } from '@/sql-executor';
import {
  fetchUpcomingMemeSubscriptions,
  fetchUpcomingMemeSubscriptionStatusForConsolidationKey,
  fetchMemeSubscriptionCount,
  updateSubscriptionMode,
  updateSubscription,
  updateSubscriptionCount
} from './api.subscriptions.db';
import { getSubscriptionCutoffMemeId } from './subscription-cutoff';

jest.mock('@/db-api', () => ({}));
jest.mock('@/nftsLoop/db.nfts', () => ({ getMaxMemeId: jest.fn() }));
jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(),
    oneOrNull: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn()
  }
}));
jest.mock('@/subscriptionsDaily/db.subscriptions', () => ({
  fetchSubscriptionEligibility: jest.fn().mockResolvedValue(3),
  fetchSubscriptionEligibilityForKeys: jest.fn().mockResolvedValue(new Map())
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirty: jest.fn()
}));

const profileKey = '0xsubscriber';
const execute = jest.mocked(sqlExecutor.execute);
let automatic: boolean;
let savedSubscriptions: Array<{
  consolidation_key: string;
  contract: string;
  token_id: number;
  subscribed: boolean;
  subscribed_count: number;
}>;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-09-14T08:00:00Z'));
  automatic = true;
  savedSubscriptions = [];
  jest.mocked(getMaxMemeId).mockResolvedValue(547);
  jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue({
    id: 547,
    mint_timestamp: Date.parse('2026-09-11T15:40:00Z') / 1000
  });
  const eligibility = jest.requireMock('@/subscriptionsDaily/db.subscriptions');
  eligibility.fetchSubscriptionEligibility.mockResolvedValue(3);
  eligibility.fetchSubscriptionEligibilityForKeys.mockResolvedValue(new Map());
  execute.mockImplementation(async (sql, params) => {
    if (
      sql.startsWith('SELECT') &&
      sql.includes(`FROM ${SUBSCRIPTIONS_MODE_TABLE}`)
    ) {
      return [
        {
          automatic,
          consolidation_key: profileKey,
          subscribe_all_editions: true
        }
      ];
    }
    if (
      sql.startsWith('SELECT') &&
      sql.includes(`FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`)
    ) {
      return [{ consolidation_key: profileKey, balance: 1 }];
    }
    if (
      sql.startsWith('SELECT') &&
      sql.includes(`FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`)
    ) {
      return [{ count: 7 }];
    }
    if (
      sql.trimStart().startsWith('SELECT') &&
      sql.includes(SUBSCRIPTIONS_NFTS_TABLE)
    ) {
      return savedSubscriptions.filter(
        (sub) =>
          params?.tokenId === undefined || sub.token_id === params.tokenId
      );
    }
    return [];
  });
  jest
    .mocked(sqlExecutor.executeNativeQueriesInTransaction)
    .mockImplementation(async (fn) => fn({ connection: {} }));
});
afterEach(() => jest.useRealTimers());

it.each([
  '2026-09-14T00:00:00Z',
  '2026-09-16T08:00:00Z',
  '2026-09-18T23:59:59Z'
])('closes the unreleased card on mint day at %s', async (instant) => {
  jest.setSystemTime(new Date(instant));
  await expect(getSubscriptionCutoffMemeId()).resolves.toBe(548);
});
it.each(['2026-09-13T23:59:59Z', '2026-09-15T08:00:00Z'])(
  'leaves the next card open before its mint day at %s',
  async (instant) => {
    jest.setSystemTime(new Date(instant));
    await expect(getSubscriptionCutoffMemeId()).resolves.toBe(547);
  }
);
it('does not skip the following card after today has dropped', async () => {
  jest.mocked(getMaxMemeId).mockResolvedValue(548);
  jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue({
    id: 548,
    mint_timestamp: Date.parse('2026-09-14T15:40:00Z') / 1000
  });
  await expect(getSubscriptionCutoffMemeId()).resolves.toBe(548);
});
it.each([true, false])(
  'does not infer today from automatic mode %s when no card record exists',
  async (mode) => {
    automatic = mode;
    const rows = await fetchUpcomingMemeSubscriptions(profileKey, 2);
    expect(
      rows.map(({ token_id, subscribed }) => ({ token_id, subscribed }))
    ).toEqual([
      { token_id: 548, subscribed: false },
      { token_id: 549, subscribed: mode }
    ]);
    await expect(
      fetchUpcomingMemeSubscriptionStatusForConsolidationKey(profileKey, 548)
    ).resolves.toEqual({ subscribed: false, eligibility: 3 });
  }
);
it('uses automatic mode for the same card before cutoff', async () => {
  jest.setSystemTime(new Date('2026-09-13T23:59:59Z'));
  expect(
    (await fetchUpcomingMemeSubscriptions(profileKey, 1))[0].subscribed
  ).toBe(true);
  await expect(
    fetchUpcomingMemeSubscriptionStatusForConsolidationKey(profileKey, 548)
  ).resolves.toMatchObject({ subscribed: true, count: 3, source: 'automatic' });
});
it.each([true, false])(
  'preserves a saved card choice of %s independently of current mode',
  async (subscribed) => {
    automatic = !subscribed;
    savedSubscriptions = [
      {
        consolidation_key: profileKey,
        contract: MEMES_CONTRACT,
        token_id: 548,
        subscribed,
        subscribed_count: 2
      }
    ];
    expect(
      (await fetchUpcomingMemeSubscriptions(profileKey, 1))[0]
    ).toMatchObject({ subscribed, subscribed_count: 2 });
    expect(
      await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
        profileKey,
        548
      )
    ).toMatchObject({ subscribed });
  }
);
it.each([false, true])(
  'enabling automatic mode via %s transaction path does not enroll today',
  async (existingTransaction) => {
    // First top-up passes its transaction to the same mode updater used by the API.
    await updateSubscriptionMode(
      profileKey,
      true,
      existingTransaction ? { connection: {} } : undefined
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('token_id > :maxMemeId'),
      expect.objectContaining({ maxMemeId: 548 }),
      expect.anything()
    );
    expect(
      (await fetchUpcomingMemeSubscriptions(profileKey, 1))[0].subscribed
    ).toBe(false);
  }
);
it('uses the frozen final count on mint day instead of new automatic subscribers or top-ups', async () => {
  await expect(fetchMemeSubscriptionCount(548)).resolves.toMatchObject({
    count: 7
  });
});
it.each([true, false])(
  'rejects a direct subscription change to %s after cutoff',
  async (subscribed) => {
    await expect(
      updateSubscription(profileKey, MEMES_CONTRACT, 548, subscribed)
    ).rejects.toThrow('Subscriptions are closed');
    expect(
      sqlExecutor.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  }
);
it('rejects quantity changes after cutoff', async () => {
  await expect(
    updateSubscriptionCount(profileKey, MEMES_CONTRACT, 548, 2)
  ).rejects.toThrow('Subscriptions are closed');
  expect(sqlExecutor.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
});

it.each([
  ['2026-09-13T23:59:59Z', 548],
  ['2026-09-14T00:00:00Z', 547]
])(
  'compares the timestamp epoch at the UTC boundary (%s)',
  async (mintedAt, cutoff) => {
    jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue({
      id: 547,
      mint_timestamp: Date.parse(mintedAt) / 1000
    });
    await expect(getSubscriptionCutoffMemeId()).resolves.toBe(cutoff);
  }
);
it.each([null, { id: 547, mint_timestamp: null }])(
  'does not infer an unreleased card without a mint timestamp (%j)',
  async (latest) => {
    jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue(latest);
    await expect(getSubscriptionCutoffMemeId()).resolves.toBe(latest?.id ?? 0);
  }
);
it.each(['selection', 'quantity'])(
  'rechecks a %s write inside its transaction when midnight passes',
  async (change) => {
    jest.setSystemTime(new Date('2026-09-13T23:59:59Z'));
    const wrappedConnection = { connection: {} };
    jest
      .mocked(sqlExecutor.executeNativeQueriesInTransaction)
      .mockImplementation(async (fn) => {
        jest.setSystemTime(new Date('2026-09-14T00:00:00Z'));
        return fn(wrappedConnection);
      });
    const update =
      change === 'selection'
        ? updateSubscription(profileKey, MEMES_CONTRACT, 548, true)
        : updateSubscriptionCount(profileKey, MEMES_CONTRACT, 548, 2);
    await expect(update).rejects.toThrow('Subscriptions are closed');
    expect(sqlExecutor.oneOrNull).toHaveBeenLastCalledWith(
      expect.any(String),
      { contract: MEMES_CONTRACT },
      { wrappedConnection }
    );
  }
);
it.each(['selection', 'quantity'])(
  'allows a %s write for a future card',
  async (change) => {
    const update =
      change === 'selection'
        ? updateSubscription(profileKey, MEMES_CONTRACT, 549, true)
        : updateSubscriptionCount(profileKey, MEMES_CONTRACT, 549, 2);
    await expect(update).resolves.toMatchObject({ token_id: 549 });
  }
);
