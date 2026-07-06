import { DbQueryOptions } from '../db-query.options';
import { setSqlExecutor, SqlExecutor } from '../sql-executor';
import {
  fetchSubscriptionEligibility,
  fetchSubscriptionEligibilityForKeys
} from './db.subscriptions';

type ExecutedQuery = { sql: string; params?: Record<string, any> };

class MockSqlExecutor extends SqlExecutor {
  public readonly queries: ExecutedQuery[] = [];

  constructor(
    private readonly maxSeasonId: number | null,
    private readonly setsByKey: Record<string, number>
  ) {
    super();
  }

  async execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    _options?: DbQueryOptions
  ): Promise<T[]> {
    this.queries.push({ sql, params });
    if (sql.includes('MAX(id)')) {
      return [{ max_id: this.maxSeasonId }] as T[];
    }
    if (sql.includes('consolidation_key IN')) {
      const chunk: string[] = params?.chunk ?? [];
      return chunk
        .filter((key) => this.setsByKey[key.toLowerCase()] !== undefined)
        .map((key) => ({
          consolidation_key: key,
          sets: this.setsByKey[key.toLowerCase()]
        })) as T[];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  async executeNativeQueriesInTransaction<T>(): Promise<T> {
    throw new Error('Not supported in this test');
  }
}

describe('fetchSubscriptionEligibilityForKeys', () => {
  it('defaults every key to 1 with a single query when there are no seasons', async () => {
    const executor = new MockSqlExecutor(null, {});
    setSqlExecutor(executor);

    const result = await fetchSubscriptionEligibilityForKeys([
      '0xA-0xB',
      '0xc'
    ]);

    expect(result.get('0xa-0xb')).toBe(1);
    expect(result.get('0xc')).toBe(1);
    expect(executor.queries).toHaveLength(1);
  });

  it('maps card sets per key, defaults missing/zero-set keys to 1 and lowercases keys', async () => {
    const executor = new MockSqlExecutor(11, {
      '0xa-0xb': 3,
      '0xzero': 0
    });
    setSqlExecutor(executor);

    const result = await fetchSubscriptionEligibilityForKeys([
      '0xA-0xB',
      '0xZERO',
      '0xmissing',
      '',
      '0xA-0xB' // duplicate
    ]);

    expect(result.get('0xa-0xb')).toBe(3);
    expect(result.get('0xzero')).toBe(1);
    expect(result.get('0xmissing')).toBe(1);
    expect(result.has('')).toBe(false);
    // one MAX query + one IN query for the three distinct keys
    expect(executor.queries).toHaveLength(2);
    expect(executor.queries[1].params?.chunk).toEqual([
      '0xA-0xB',
      '0xZERO',
      '0xmissing'
    ]);
    expect(executor.queries[1].params?.seasonId).toBe(11);
  });

  it('chunks the IN query above 5000 distinct keys', async () => {
    const keys = Array.from({ length: 5001 }, (_, i) => `0xkey${i}`);
    const executor = new MockSqlExecutor(11, {});
    setSqlExecutor(executor);

    await fetchSubscriptionEligibilityForKeys(keys);

    // 1 MAX query + 2 chunked IN queries
    expect(executor.queries).toHaveLength(3);
    expect(executor.queries[1].params?.chunk).toHaveLength(5000);
    expect(executor.queries[2].params?.chunk).toHaveLength(1);
  });
});

describe('fetchSubscriptionEligibility (single key, unchanged behavior)', () => {
  it('returns the card set count when present', async () => {
    setSqlExecutor(new MockSqlExecutor(11, { '0xa-0xb': 4 }));
    await expect(fetchSubscriptionEligibility('0xA-0xB')).resolves.toBe(4);
  });

  it('returns 1 when the key has no card sets', async () => {
    setSqlExecutor(new MockSqlExecutor(11, {}));
    await expect(fetchSubscriptionEligibility('0xnobody')).resolves.toBe(1);
  });

  it('returns 1 when there are no seasons', async () => {
    setSqlExecutor(new MockSqlExecutor(null, {}));
    await expect(fetchSubscriptionEligibility('0xa-0xb')).resolves.toBe(1);
  });
});
