import { fetchWalletConsolidationKeysViewForWallet, getDataSource } from '@/db';
import { DbQueryOptions } from '@/db-query.options';
import { setSqlExecutor, SqlExecutor } from '@/sql-executor';
import { consolidateSubscriptions } from './subscriptions';

jest.mock('@/db', () => ({
  fetchAllProfiles: jest.fn(),
  fetchWalletConsolidationKeysViewForWallet: jest.fn(),
  getDataSource: jest.fn()
}));

jest.mock('../delegationsLoop/db.delegations', () => ({
  fetchAirdropAddressForConsolidationKey: jest.fn()
}));

jest.mock('../nftsLoop/db.nfts', () => ({
  getMaxMemeId: jest.fn()
}));

jest.mock('../notifier-discord', () => ({
  sendDiscordUpdate: jest.fn()
}));

jest.mock('../subscription-wave-notifier', () => ({
  sendDailySubscriptionsWaveUpdate: jest.fn()
}));

jest.mock('../arweave', () => ({
  arweaveFileUploader: { uploadFile: jest.fn() }
}));

jest.mock('./db.subscriptions', () => ({
  fetchAllAutoSubscriptions: jest.fn(),
  fetchAllNftSubscriptions: jest.fn(),
  fetchAllNftSubscriptionBalances: jest.fn(),
  fetchSubscriptionEligibilityForKeys: jest.fn(),
  fetchSubscriptionEligibility: jest.fn(),
  persistNFTFinalSubscriptions: jest.fn(),
  persistSubscriptions: jest.fn()
}));

const mockedFetchWalletConsolidationKeysViewForWallet =
  fetchWalletConsolidationKeysViewForWallet as jest.MockedFunction<
    typeof fetchWalletConsolidationKeysViewForWallet
  >;
const mockedGetDataSource = getDataSource as jest.MockedFunction<
  typeof getDataSource
>;

type ExecutedQuery = { sql: string; params?: Record<string, any> };

class MockSqlExecutor extends SqlExecutor {
  public readonly queries: ExecutedQuery[] = [];

  constructor(
    private readonly affectedSubscriptions: {
      consolidation_key: string;
      balance: number;
    }[],
    private readonly tdhByKey: Record<string, number>
  ) {
    super();
  }

  async execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    _options?: DbQueryOptions
  ): Promise<T[]> {
    this.queries.push({ sql, params });
    if (sql.includes('LIKE')) {
      return this.affectedSubscriptions as T[];
    }
    if (sql.includes('boosted_tdh')) {
      const chunk: string[] = params?.chunk ?? [];
      return chunk
        .filter((key) => this.tdhByKey[key] !== undefined)
        .map((key) => ({
          consolidation_key: key,
          boosted_tdh: this.tdhByKey[key]
        })) as T[];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  async executeNativeQueriesInTransaction<T>(): Promise<T> {
    throw new Error('Not supported in this test');
  }
}

describe('consolidateSubscriptions', () => {
  const managerQueries: { sql: string; params?: any[] }[] = [];
  const balancesByKey: Record<string, number> = {
    '0xa-0xb': 3,
    '0xc': 7
  };

  const defaultQuery = async (sql: string, params?: any[]): Promise<any[]> => {
    managerQueries.push({ sql, params });
    if (sql.includes('SUM(balance)')) {
      const total = (params ?? []).reduce(
        (acc: number, key: string) => acc + (balancesByKey[key] ?? 0),
        0
      );
      return [{ total_balance: total }];
    }
    if (sql.includes('automatic_count')) {
      return [{ automatic_count: 0 }];
    }
    return [];
  };
  const fakeManager = { query: jest.fn(defaultQuery) };

  beforeEach(() => {
    jest.clearAllMocks();
    fakeManager.query.mockImplementation(defaultQuery);
    managerQueries.length = 0;
    mockedGetDataSource.mockReturnValue({
      transaction: async (fn: any) => fn(fakeManager)
    } as any);
    // 0xa moved into a new consolidation with 0xd; 0xb and 0xc are unchanged
    mockedFetchWalletConsolidationKeysViewForWallet.mockImplementation(
      async (addresses) =>
        addresses
          .filter((a) => a.toLowerCase() === '0xa')
          .map(
            (a) =>
              ({
                address: a.toLowerCase(),
                consolidation_key: '0xa-0xd'
              }) as any
          )
    );
  });

  it('migrates subscription keys using batched lookups with identical decision logic', async () => {
    const executor = new MockSqlExecutor(
      [
        { consolidation_key: '0xa-0xb', balance: 3 },
        { consolidation_key: '0xc', balance: 7 }
      ],
      { '0xa-0xd': 100, '0xb': 50 }
    );
    setSqlExecutor(executor);

    await consolidateSubscriptions(new Set(['0xd']));

    // affected-subscriptions query is parameterized, not string-concatenated
    const likeQuery = executor.queries.find((q) => q.sql.includes('LIKE'));
    expect(likeQuery?.sql).toContain(':addressPattern0');
    expect(likeQuery?.sql).not.toContain('%0xd%');
    expect(likeQuery?.params?.addressPattern0).toBe('%0xd%');

    // one batched view lookup for all wallet parts, one TDH lookup for all candidates
    expect(
      mockedFetchWalletConsolidationKeysViewForWallet
    ).toHaveBeenCalledTimes(1);
    expect(
      [
        ...mockedFetchWalletConsolidationKeysViewForWallet.mock.calls[0][0]
      ].sort((a, b) => a.localeCompare(b))
    ).toEqual(['0xa', '0xb', '0xc']);
    const tdhQueries = executor.queries.filter((q) =>
      q.sql.includes('boosted_tdh')
    );
    expect(tdhQueries).toHaveLength(1);
    expect(
      [...(tdhQueries[0].params?.chunk ?? [])].sort((a, b) =>
        a.localeCompare(b)
      )
    ).toEqual(['0xa-0xd', '0xb', '0xc']);

    // 0xa-0xb migrates to 0xa-0xd (TDH 100 beats 0xb's 50); 0xc keeps its
    // key, so its rows need no update
    const updates = managerQueries.filter((q) => q.sql.includes('UPDATE'));
    const migrationPairs = new Set(updates.map((u) => u.params?.join('<-')));
    expect(migrationPairs).toEqual(new Set(['0xa-0xd<-0xa-0xb']));
    // 4 tables for the one moved key
    expect(updates).toHaveLength(4);
    // re-keying keeps the subscription priority timestamps
    expect(
      updates
        .filter((u) => u.sql.includes('subscriptions_nfts'))
        .every((u) => u.sql.includes('updated_at = updated_at'))
    ).toBe(true);

    // balances re-inserted under the new keys with summed balances
    const balanceInserts = managerQueries.filter(
      (q) =>
        q.sql.includes('INSERT INTO') && q.sql.includes('balance') && q.params
    );
    const inserted = new Map(
      balanceInserts.map((q) => [q.params?.[0], q.params?.[1]])
    );
    expect(inserted.get('0xa-0xd')).toBe(3);
    expect(inserted.get('0xc')).toBe(7);
  });

  it('combines rows for the same card instead of orphaning the old key', async () => {
    const executor = new MockSqlExecutor(
      [{ consolidation_key: '0xa-0xb', balance: 3 }],
      { '0xa-0xd': 100, '0xb': 50 }
    );
    setSqlExecutor(executor);
    fakeManager.query.mockImplementation(
      async (sql: string, params?: any[]) => {
        managerQueries.push({ sql, params });
        if (sql.includes('surviving_subscribed')) {
          return [
            {
              surviving_id: 11,
              surviving_subscribed: 1,
              surviving_automatic_subscription: 1,
              surviving_subscribed_count: 2,
              surviving_updated_at: '2026-10-05T00:00:00.000Z',
              merged_id: 22,
              merged_subscribed: 1,
              merged_automatic_subscription: 0,
              merged_subscribed_count: 3,
              merged_updated_at: '2026-10-02T00:00:00.000Z'
            }
          ];
        }
        if (sql.includes('merged.id AS id')) {
          return [{ id: 77, contract: '0xmemes', token_id: 400 }];
        }
        if (sql.includes('SUM(balance)')) {
          return [{ total_balance: 3 }];
        }
        if (sql.includes('automatic_count')) {
          return [{ automatic_count: 0 }];
        }
        return [];
      }
    );

    await consolidateSubscriptions(new Set(['0xd']));

    const combined = managerQueries.find((q) => q.sql.includes('WHERE id = ?'));
    expect(combined?.params).toEqual([
      true,
      false,
      3,
      new Date('2026-10-02T00:00:00.000Z'),
      11
    ]);
    const deleted = managerQueries.find((q) =>
      q.sql.includes('DELETE FROM subscriptions_nfts WHERE id')
    );
    expect(deleted?.params).toEqual([22]);

    // the conflicting final allocation stays under the old key
    const finalUpdate = managerQueries.find(
      (q) =>
        q.sql.includes('UPDATE subscriptions_nfts_final') &&
        q.sql.includes('NOT IN')
    );
    expect(finalUpdate?.params).toEqual(['0xa-0xd', '0xa-0xb', 77]);
  });

  it('rolls back only the consolidation whose move fails', async () => {
    const executor = new MockSqlExecutor(
      [
        { consolidation_key: '0xa-0xb', balance: 3 },
        { consolidation_key: '0xc', balance: 7 }
      ],
      { '0xa-0xd': 100, '0xb': 50 }
    );
    setSqlExecutor(executor);
    fakeManager.query.mockImplementation(
      async (sql: string, params?: any[]): Promise<any[]> => {
        managerQueries.push({ sql, params });
        if (
          sql.includes('UPDATE subscriptions_nfts') &&
          !sql.includes('subscriptions_nfts_final') &&
          sql.includes('updated_at = updated_at') &&
          params?.[1] === '0xa-0xb'
        ) {
          throw new Error("Duplicate entry '0xa-0xd-0x0-1' for key");
        }
        if (sql.includes('SUM(balance)')) {
          return [{ total_balance: 7 }];
        }
        if (sql.includes('automatic_count')) {
          return [{ automatic_count: 0 }];
        }
        return [];
      }
    );

    await expect(
      consolidateSubscriptions(new Set(['0xd']))
    ).resolves.toBeUndefined();

    const statements = managerQueries.map((q) => q.sql.trim());
    expect(statements).toContain(
      'ROLLBACK TO SAVEPOINT consolidate_subscriptions_0'
    );
    expect(statements).not.toContain(
      'RELEASE SAVEPOINT consolidate_subscriptions_0'
    );
    expect(statements).toContain(
      'RELEASE SAVEPOINT consolidate_subscriptions_1'
    );
    const balanceInserts = managerQueries.filter(
      (q) =>
        q.sql.includes('INSERT INTO') && q.sql.includes('balance') && q.params
    );
    expect(balanceInserts.map((q) => q.params?.[0])).toEqual(['0xc']);
  });
  it('aborts with the original error when the transaction itself was lost', async () => {
    const executor = new MockSqlExecutor(
      [
        { consolidation_key: '0xa-0xb', balance: 3 },
        { consolidation_key: '0xc', balance: 7 }
      ],
      { '0xa-0xd': 100, '0xb': 50 }
    );
    setSqlExecutor(executor);
    const deadlock = new Error('Deadlock found when trying to get lock');
    fakeManager.query.mockImplementation(
      async (sql: string, params?: any[]): Promise<any[]> => {
        managerQueries.push({ sql, params });
        if (
          sql.includes('UPDATE subscriptions_nfts') &&
          !sql.includes('subscriptions_nfts_final') &&
          sql.includes('updated_at = updated_at') &&
          params?.[1] === '0xa-0xb'
        ) {
          throw deadlock;
        }
        // MySQL rolled back the whole transaction, savepoints included.
        if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
          throw new Error(
            'SAVEPOINT consolidate_subscriptions_0 does not exist'
          );
        }
        return [];
      }
    );

    await expect(consolidateSubscriptions(new Set(['0xd']))).rejects.toBe(
      deadlock
    );

    // nothing runs after the failed rollback, outside the transaction
    const statements = managerQueries.map((q) => q.sql.trim());
    expect(statements[statements.length - 1]).toBe(
      'ROLLBACK TO SAVEPOINT consolidate_subscriptions_0'
    );
    expect(statements).not.toContain('SAVEPOINT consolidate_subscriptions_1');
  });

  it('folds an existing balance and mode row of the new key into the merge', async () => {
    const executor = new MockSqlExecutor(
      [{ consolidation_key: '0xa-0xb', balance: 3 }],
      { '0xa-0xd': 100, '0xb': 50 }
    );
    setSqlExecutor(executor);
    balancesByKey['0xa-0xd'] = 2;
    try {
      await consolidateSubscriptions(new Set(['0xd']));
    } finally {
      delete balancesByKey['0xa-0xd'];
    }

    const sum = managerQueries.find((q) => q.sql.includes('SUM(balance)'));
    expect(sum?.params).toEqual(['0xa-0xb', '0xa-0xd']);
    const deletedKeys = managerQueries
      .filter((q) => q.sql.includes('DELETE FROM subscriptions_balances'))
      .map((q) => q.params?.[0]);
    expect(deletedKeys).toEqual(['0xa-0xb', '0xa-0xd']);
    const balanceInsert = managerQueries.find(
      (q) =>
        q.sql.includes('INSERT INTO') && q.sql.includes('balance') && q.params
    );
    expect(balanceInsert?.params).toEqual(['0xa-0xd', 5]);
  });
});
