import { CONSOLIDATED_WALLETS_TDH_TABLE } from '@/constants';
import { setSqlExecutor, SqlExecutor } from '@/sql-executor';
import {
  fetchNfts,
  fetchSingleAddressTDH,
  fetchTDHAbove
} from './api.oracle.db';

class MockSqlExecutor extends SqlExecutor {
  public constructor(
    private readonly executeMock: jest.Mock<
      Promise<any[]>,
      [string, Record<string, any>?]
    >
  ) {
    super();
  }

  public async execute(sql: string, params?: Record<string, any>) {
    return this.executeMock(sql, params);
  }

  public async executeNativeQueriesInTransaction<T>(): Promise<T> {
    throw new Error('Not implemented');
  }
}

describe('api.oracle.db', () => {
  const tdhRow = {
    boosted_tdh: 100,
    boosted_memes_tdh: 60,
    boosted_gradients_tdh: 30,
    boosted_nextgen_tdh: 10,
    boost: 1,
    wallets: JSON.stringify(['0xabc']),
    memes: JSON.stringify([]),
    gradients: JSON.stringify([]),
    nextgen: JSON.stringify([])
  };

  function installSqlExecutor() {
    const execute: jest.Mock<
      Promise<any[]>,
      [string, Record<string, any>?]
    > = jest.fn(async (sql: string) => {
      if (sql.includes('MAX(block)')) {
        return [{ block: 123 }];
      }
      if (sql.includes('merkle_root')) {
        return [{ merkle_root: 'root' }];
      }
      if (sql.includes('LOWER(consolidation_key)')) {
        return [tdhRow];
      }
      if (sql.includes('FROM memes_extended_data')) {
        return [];
      }
      return [];
    });

    setSqlExecutor(new MockSqlExecutor(execute));
    return execute;
  }

  it('binds address search input as a query parameter', async () => {
    const execute = installSqlExecutor();

    await fetchSingleAddressTDH("0xABC%' OR 1=1 --");

    const addressQueryCalls = execute.mock.calls.filter(([sql]) =>
      sql.includes('LOWER(consolidation_key)')
    );

    expect(addressQueryCalls).toHaveLength(2);
    for (const [sql, params] of addressQueryCalls) {
      expect(sql).toContain('like :addressPattern');
      expect(sql).not.toContain('OR 1=1');
      expect(params).toEqual({
        addressPattern: "%0xabc%' or 1=1 --%"
      });
    }
  });

  it('binds contract and token id when fetching nfts', async () => {
    const execute = installSqlExecutor();

    await fetchNfts("memes%' OR 1=1 --", 1);

    const nftQueryCall = execute.mock.calls.find(([sql]) =>
      sql.includes('FROM tdh_nft')
    );

    expect(nftQueryCall).toBeDefined();
    const [sql, params] = nftQueryCall!;
    expect(sql).toContain('WHERE contract = :contract');
    expect(sql).toContain('AND id = :id');
    expect(sql).not.toContain('OR 1=1');
    expect(params).toEqual({
      contract: "memes%' or 1=1 --",
      id: 1
    });
  });

  it('binds TDH threshold input as a query parameter', async () => {
    const execute = installSqlExecutor();

    await fetchTDHAbove(100, false);

    const tdhAboveQueryCall = execute.mock.calls.find(
      ([sql]) =>
        sql.includes(`from ${CONSOLIDATED_WALLETS_TDH_TABLE}`) &&
        sql.includes('boosted_tdh >= :value')
    );

    expect(tdhAboveQueryCall).toBeDefined();
    expect(tdhAboveQueryCall?.[1]).toEqual({ value: 100 });
  });
});
