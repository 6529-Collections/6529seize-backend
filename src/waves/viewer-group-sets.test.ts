import * as mysql from 'mysql';
import { SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import {
  VIEWER_GROUP_SET_MIN_JSON_BYTES,
  ViewerGroupSets,
  viewerGroupSetHash,
  viewerGroupSetJsonChunks
} from './viewer-group-sets';

const uuid = (i: number) =>
  `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
/** About 16 KB as JSON: stored as a set. */
const large = Array.from({ length: 400 }, (_, i) => uuid(i));
/** Below VIEWER_GROUP_SET_MIN_JSON_BYTES: always the JSON copy. */
const small = large.slice(0, 50);

type Call = { sql: string; params: Record<string, unknown>; tx: boolean };

/** Records statements; `headers` is the set of hashes whose header exists. */
function fakeDb({
  headers = new Set<string>(),
  collation = 'utf8mb4_0900_ai_ci',
  failWrites = false
}: {
  headers?: Set<string>;
  collation?: string;
  failWrites?: boolean;
} = {}) {
  const calls: Call[] = [];
  let inTx = false;
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown> = {}) => {
      calls.push({ sql, params, tx: inTx });
      if (sql.includes('information_schema.columns'))
        return [{ collation_name: collation }];
      if (sql.includes('select 1 as present'))
        return headers.has(params.hash as string) ? [{ present: 1 }] : [];
      if (sql.startsWith('insert ignore into viewer_group_sets'))
        headers.add(params.hash as string);
      return [];
    }
  );
  const executeNativeQueriesInTransaction = jest.fn(
    async (work: (c: unknown) => Promise<unknown>, options?: unknown) => {
      expect(options).toMatchObject({
        executionBudget: { lockWaitSeconds: 1 }
      });
      if (failWrites) throw new Error('lock wait timeout');
      inTx = true;
      try {
        return await work({ connection: {} });
      } finally {
        inTx = false;
      }
    }
  );
  const db = {
    execute,
    executeNativeQueriesInTransaction
  } as unknown as SqlExecutor;
  return { db, calls, headers, executeNativeQueriesInTransaction };
}

function sets({
  lease = async () => true as boolean | null,
  enabled = true,
  now = () => 1_000_000
}: {
  lease?: (key: string, ttl: Time) => Promise<boolean | null>;
  enabled?: boolean;
  now?: () => number;
} = {}) {
  return new ViewerGroupSets(jest.fn(lease), () => enabled, now);
}

const isJson = (cte: { cteSql: string }) => cte.cteSql.includes('json_table');
const isTable = (cte: { cteSql: string }) =>
  cte.cteSql.includes('viewer_group_set_members');

describe('viewerGroupSetHash', () => {
  it('ignores order and duplicates', () => {
    expect(viewerGroupSetHash(['b', 'a', 'b'])).toBe(
      viewerGroupSetHash(['a', 'b'])
    );
    expect(viewerGroupSetHash(['a', 'b'])).not.toBe(
      viewerGroupSetHash(['a', 'c'])
    );
    expect(viewerGroupSetHash(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('viewerGroupSetJsonChunks', () => {
  it('splits into escaped chunks of at most the budget, covering every id once', () => {
    const chunks = viewerGroupSetJsonChunks([...large, large[0]], 4_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(Buffer.byteLength(mysql.escape(chunk))).toBeLessThanOrEqual(4_000);
    expect(chunks.flatMap((chunk) => JSON.parse(chunk))).toEqual(large);
  });
});

describe('ViewerGroupSets.source', () => {
  it('uses the JSON copy while the feature is off, without touching the database', async () => {
    const { db, calls } = fakeDb();
    const cte = await sets({ enabled: false }).source(db, 'x_groups', large);
    expect(isJson(cte)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('uses the JSON copy for small sets, without touching the database', async () => {
    expect(Buffer.byteLength(mysql.escape(JSON.stringify(small)))).toBeLessThan(
      VIEWER_GROUP_SET_MIN_JSON_BYTES
    );
    const { db, calls } = fakeDb();
    const cte = await sets().source(db, 'x_groups', small);
    expect(isJson(cte)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('uses the JSON copy while the members column collation differs', async () => {
    const { db, calls } = fakeDb({ collation: 'utf8mb4_unicode_ci' });
    const cte = await sets().source(db, 'x_groups', large);
    expect(isJson(cte)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reads a stored set by hash: the same hinted reference, one short parameter', async () => {
    const hash = viewerGroupSetHash(large);
    const { db, executeNativeQueriesInTransaction } = fakeDb({
      headers: new Set([hash])
    });
    const store = sets();
    const cte = await store.source(db, 'x_groups', large);
    expect(isTable(cte)).toBe(true);
    expect(cte.params).toEqual({ x_groups_set: hash });
    expect(cte.setSql).toBe(
      'select /*+ NO_MERGE(x_groups) SUBQUERY(MATERIALIZATION) */ id from x_groups'
    );
    // The first use touches the header once (another container may own it).
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls back to JSON while the header is missing where it reads, and writes the set once', async () => {
    const { db, calls, headers } = fakeDb();
    const lease = jest.fn(async () => true as boolean | null);
    const store = sets({ lease });
    const first = await store.source(db, 'x_groups', large);
    expect(isJson(first)).toBe(true);
    // Members in chunks within budget, then the header, all in one transaction.
    const writes = calls.filter((call) => call.tx);
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.at(-1)!.sql).toContain(
      'insert ignore into viewer_group_sets'
    );
    for (const write of writes.slice(0, -1)) {
      expect(write.sql).toContain(
        'insert ignore into viewer_group_set_members'
      );
      expect(
        Buffer.byteLength(mysql.escape(write.params.json as string))
      ).toBeLessThanOrEqual(11_000);
    }
    expect(lease).toHaveBeenCalledWith(
      `viewer_group_set:write:${viewerGroupSetHash(large)}`,
      expect.anything()
    );
    expect(headers.has(viewerGroupSetHash(large))).toBe(true);
    const second = await store.source(db, 'x_groups', large);
    expect(isTable(second)).toBe(true);
  });

  it('writes nothing when another container holds the write lease or Redis is unavailable', async () => {
    for (const result of [false, null]) {
      const { db, calls } = fakeDb();
      const cte = await sets({ lease: async () => result }).source(
        db,
        'x_groups',
        large
      );
      expect(isJson(cte)).toBe(true);
      expect(calls.filter((call) => call.tx)).toHaveLength(0);
    }
  });

  it('answers from JSON without throwing when the write fails or times out', async () => {
    const { db } = fakeDb({ failWrites: true });
    const cte = await sets().source(db, 'x_groups', large);
    expect(isJson(cte)).toBe(true);
  });

  it('writes a set once per container for concurrent first sights', async () => {
    const { db, executeNativeQueriesInTransaction } = fakeDb();
    const store = sets();
    await Promise.all([
      store.source(db, 'a_groups', large),
      store.source(db, 'b_groups', large)
    ]);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
  });

  it('touches a used set at most daily, and re-checks the header after six hours', async () => {
    const hash = viewerGroupSetHash(large);
    const { db, calls, executeNativeQueriesInTransaction } = fakeDb({
      headers: new Set([hash])
    });
    let now = 1_000_000;
    const store = sets({ now: () => now });
    await store.source(db, 'x_groups', large);
    await store.source(db, 'x_groups', large);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    const headerChecks = () =>
      calls.filter((call) => call.sql.includes('select 1 as present')).length;
    expect(headerChecks()).toBe(1);
    now += Time.hours(7).toMillis();
    await store.source(db, 'x_groups', large);
    expect(headerChecks()).toBe(2);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    now += Time.days(1).toMillis();
    await store.source(db, 'x_groups', large);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(2);
  });
});
