import * as mysql from 'mysql';
import { SqlExecutor } from '@/sql-executor';
import { withRequestDeadline } from '@/api/write-transaction-budget';
import { Time } from '@/time';
import {
  VIEWER_GROUP_SET_MIN_JSON_BYTES,
  VIEWER_GROUP_SET_SETTLE_MS,
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

/**
 * Records statements. `headers` maps stored hashes to their last_used_at
 * (their created_at is long ago unless this fake wrote them: then it is the
 * write's time);
 * `dropMembers` stores that many fewer members than asked (INSERT IGNORE
 * dropping rows); `vanishOnTouch` deletes the header just before a touch.
 */
function fakeDb({
  headers = new Map<string, number>(),
  collation = 'utf8mb4_0900_ai_ci',
  failWrites = false,
  dropMembers = 0,
  vanishOnTouch = false
}: {
  headers?: Map<string, number>;
  collation?: string;
  failWrites?: boolean;
  dropMembers?: number;
  vanishOnTouch?: boolean;
} = {}) {
  const calls: Call[] = [];
  const members = new Map<string, number>();
  const createdAt = new Map<string, number>();
  let inTx = false;
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown> = {}): Promise<any> => {
      calls.push({ sql, params, tx: inTx });
      const hash = params.hash as string;
      if (sql.includes('information_schema.columns'))
        return [{ collation_name: collation }];
      if (
        sql.includes('select last_used_at, created_at from viewer_group_sets')
      )
        return headers.has(hash)
          ? [
              {
                last_used_at: headers.get(hash),
                created_at: createdAt.get(hash) ?? 0
              }
            ]
          : [];
      if (sql.includes('insert ignore into viewer_group_set_members')) {
        const ids = JSON.parse(params.json as string) as string[];
        members.set(hash, (members.get(hash) ?? 0) + ids.length);
        return [];
      }
      if (sql.includes('select count(*) as n from viewer_group_set_members'))
        return [{ n: Math.max(0, (members.get(hash) ?? 0) - dropMembers) }];
      if (sql.includes('insert ignore into viewer_group_sets')) {
        headers.set(hash, params.now as number);
        createdAt.set(hash, params.now as number);
        return [];
      }
      if (sql.includes('update viewer_group_sets')) {
        if (vanishOnTouch) headers.delete(hash);
        if (!headers.has(hash)) return { affectedRows: 0 };
        headers.set(hash, params.now as number);
        return { affectedRows: 1 };
      }
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
    executeNativeQueriesInTransaction,
    getAffectedRows: (result: any) => result?.affectedRows ?? 0
  } as unknown as SqlExecutor;
  return { db, calls, headers, executeNativeQueriesInTransaction };
}

const NOW = 1_000_000_000;

function sets({
  lease = async () => true as boolean | null,
  enabled = true,
  now = () => NOW
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
      headers: new Map([[hash, NOW]])
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
    let now = NOW;
    const store = sets({ lease, now: () => now });
    const first = await store.source(db, 'x_groups', large);
    expect(isJson(first)).toBe(true);
    // Members in chunks within budget, then the header, all in one transaction.
    const writes = calls.filter((call) => call.tx);
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.at(-1)!.sql).toContain(
      'insert ignore into viewer_group_sets'
    );
    for (const write of writes.slice(0, -2)) {
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
    now += VIEWER_GROUP_SET_SETTLE_MS;
    const second = await store.source(db, 'x_groups', large);
    expect(isTable(second)).toBe(true);
  });

  it('does not read a set written moments ago, which another reader may not have yet', async () => {
    const { db, calls } = fakeDb();
    const lease = jest.fn(async () => true as boolean | null);
    let now = NOW;
    const store = sets({ lease, now: () => now });
    expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
    const writes = calls.filter((call) => call.tx).length;
    const headerChecks = () =>
      calls.filter((call) => call.sql.includes('select last_used_at')).length;
    // Settling: JSON, no second write, and not cached (checked every time).
    for (const age of [1, 1_000, VIEWER_GROUP_SET_SETTLE_MS - 1]) {
      now = NOW + age;
      const checks = headerChecks();
      expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
      expect(headerChecks()).toBe(checks + 1);
    }
    expect(calls.filter((call) => call.tx)).toHaveLength(writes);
    expect(lease).toHaveBeenCalledTimes(1);
    // Settled: read by hash, then cached.
    now = NOW + VIEWER_GROUP_SET_SETTLE_MS;
    expect(isTable(await store.source(db, 'x_groups', large))).toBe(true);
    const checks = headerChecks();
    now += 1;
    expect(isTable(await store.source(db, 'x_groups', large))).toBe(true);
    expect(headerChecks()).toBe(checks);
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
      headers: new Map([[hash, NOW]])
    });
    let now = NOW;
    const store = sets({ now: () => now });
    await store.source(db, 'x_groups', large);
    await store.source(db, 'x_groups', large);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    const headerChecks = () =>
      calls.filter((call) => call.sql.includes('select last_used_at')).length;
    expect(headerChecks()).toBe(1);
    now += Time.hours(7).toMillis();
    await store.source(db, 'x_groups', large);
    expect(headerChecks()).toBe(2);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    now += Time.days(1).toMillis();
    await store.source(db, 'x_groups', large);
    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(2);
  });
  it('writes no header when a member was dropped, and keeps the JSON copy', async () => {
    const { db, headers } = fakeDb({ dropMembers: 1 });
    const store = sets();
    expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
    expect(headers.size).toBe(0);
    expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
  });

  it('skips the write when the request has too little time left', async () => {
    const { db, executeNativeQueriesInTransaction } = fakeDb();
    // A 5.2 s request leaves 200 ms of write deadline.
    const cte = await withRequestDeadline(5_200, () =>
      sets().source(db, 'x_groups', large)
    );
    expect(isJson(cte)).toBe(true);
    expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('never reads an empty set from a cached hash that cleanup deleted', async () => {
    const hash = viewerGroupSetHash(large);
    const { db, headers } = fakeDb({ headers: new Map([[hash, NOW]]) });
    let now = NOW;
    const store = sets({ now: () => now });
    // Used every 5 hours: the header is re-checked every 6, touched daily.
    for (let hours = 0; hours <= 20; hours += 5) {
      now = NOW + Time.hours(hours).toMillis();
      expect(isTable(await store.source(db, 'x_groups', large))).toBe(true);
    }
    // Cleanup deletes the set while this container still caches its hash.
    headers.delete(hash);
    now = NOW + Time.hours(24).toMillis() + 1;
    // The daily touch finds it gone: JSON now, the hash is dropped and the
    // set is written again in full.
    expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
    expect(headers.has(hash)).toBe(true);
    // The rebuilt set is read once it has settled.
    now += 1;
    expect(isJson(await store.source(db, 'x_groups', large))).toBe(true);
    now += VIEWER_GROUP_SET_SETTLE_MS;
    expect(isTable(await store.source(db, 'x_groups', large))).toBe(true);
  });

  it('touches a set near cleanup before caching it, and drops it if it is gone', async () => {
    const hash = viewerGroupSetHash(large);
    const stale = NOW - Time.days(13).toMillis();
    const kept = fakeDb({ headers: new Map([[hash, stale]]) });
    expect(isTable(await sets().source(kept.db, 'x_groups', large))).toBe(true);
    expect(kept.headers.get(hash)).toBe(NOW);
    const gone = fakeDb({
      headers: new Map([[hash, stale]]),
      vanishOnTouch: true
    });
    expect(isJson(await sets().source(gone.db, 'x_groups', large))).toBe(true);
  });
});

describe('ViewerGroupSets.stored', () => {
  it('is undefined while the feature is off or the set is small, without touching the database', async () => {
    const { db, calls } = fakeDb();
    expect(await sets({ enabled: false }).stored(db, 'x_groups', large)).toBe(
      undefined
    );
    expect(await sets().stored(db, 'x_groups', small)).toBe(undefined);
    expect(calls).toHaveLength(0);
  });

  it('writes on first sight, is undefined while the new set settles, then reads it by hash', async () => {
    const { db, calls } = fakeDb();
    const lease = jest.fn(async () => true as boolean | null);
    let now = NOW;
    const store = sets({ lease, now: () => now });
    expect(await store.stored(db, 'x_groups', large)).toBe(undefined);
    const writes = calls.filter((call) => call.tx).length;
    expect(writes).toBeGreaterThan(0);
    now += VIEWER_GROUP_SET_SETTLE_MS - 1;
    expect(await store.stored(db, 'x_groups', large)).toBe(undefined);
    expect(calls.filter((call) => call.tx)).toHaveLength(writes);
    expect(lease).toHaveBeenCalledTimes(1);
    now += 1;
    const settled = await store.stored(db, 'x_groups', large);
    expect(settled && isTable(settled)).toBe(true);
  });
});
