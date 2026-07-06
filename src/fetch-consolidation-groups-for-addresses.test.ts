import { fetchConsolidationGroupsForAddresses } from './db';
import { DbQueryOptions } from './db-query.options';
import { setSqlExecutor, SqlExecutor } from './sql-executor';

type ExecutedQuery = { sql: string; params?: Record<string, any> };

class MockSqlExecutor extends SqlExecutor {
  public readonly queries: ExecutedQuery[] = [];

  constructor(
    private readonly consolidationKeyByAddress: Record<string, string>
  ) {
    super();
  }

  async execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    _options?: DbQueryOptions
  ): Promise<T[]> {
    this.queries.push({ sql, params });
    if (sql.includes('address IN')) {
      const addresses: string[] = params?.addresses ?? [];
      return addresses
        .filter(
          (address) =>
            this.consolidationKeyByAddress[address.toLowerCase()] !== undefined
        )
        .map((address) => ({
          address: address.toLowerCase(),
          consolidation_key:
            this.consolidationKeyByAddress[address.toLowerCase()]
        })) as T[];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  async executeNativeQueriesInTransaction<T>(): Promise<T> {
    throw new Error('Not supported in this test');
  }
}

describe('fetchConsolidationGroupsForAddresses', () => {
  it('dedupes members into one group per consolidation and falls back to singleton groups', async () => {
    const executor = new MockSqlExecutor({
      '0xalice': '0xalice-0xbob',
      '0xbob': '0xalice-0xbob'
    });
    setSqlExecutor(executor);

    const groups = await fetchConsolidationGroupsForAddresses([
      '0xAlice',
      '0xbob',
      '0xLoner'
    ]);

    expect(groups.size).toBe(2);
    expect(groups.get('0xalice-0xbob')).toEqual(['0xalice', '0xbob']);
    expect(groups.get('0xloner')).toEqual(['0xloner']);
    expect(executor.queries).toHaveLength(1);
  });

  it('keeps first-appearance group order from the input', async () => {
    const executor = new MockSqlExecutor({
      '0xalice': '0xalice-0xbob',
      '0xbob': '0xalice-0xbob'
    });
    setSqlExecutor(executor);

    const groups = await fetchConsolidationGroupsForAddresses([
      '0xLoner',
      '0xbob',
      '0xAlice'
    ]);

    expect(Array.from(groups.keys())).toEqual(['0xloner', '0xalice-0xbob']);
  });

  it('chunks the view lookup above 5000 addresses and never queries with an empty list', async () => {
    const executor = new MockSqlExecutor({});
    setSqlExecutor(executor);

    const addresses = Array.from({ length: 5001 }, (_, i) => `0xw${i}`);
    const groups = await fetchConsolidationGroupsForAddresses(addresses);

    expect(executor.queries).toHaveLength(2);
    expect(executor.queries[0].params?.addresses).toHaveLength(5000);
    expect(executor.queries[1].params?.addresses).toHaveLength(1);
    expect(groups.size).toBe(5001);

    executor.queries.length = 0;
    const empty = await fetchConsolidationGroupsForAddresses([]);
    expect(empty.size).toBe(0);
    expect(executor.queries).toHaveLength(0);
  });
});
