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

  const fakeManager = {
    query: jest.fn(async (sql: string, params?: any[]) => {
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
    })
  };

  beforeEach(() => {
    jest.clearAllMocks();
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

    // 0xa-0xb migrates to 0xa-0xd (TDH 100 beats 0xb's 50); 0xc stays
    const updates = managerQueries.filter((q) => q.sql.includes('UPDATE'));
    const migrationPairs = new Set(updates.map((u) => u.params?.join('<-')));
    expect(migrationPairs).toEqual(new Set(['0xa-0xd<-0xa-0xb', '0xc<-0xc']));
    // 4 tables per old key
    expect(updates).toHaveLength(8);

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
});
