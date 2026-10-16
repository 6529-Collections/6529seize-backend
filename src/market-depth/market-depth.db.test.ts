import 'reflect-metadata';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Logger } from '@/logging';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  type SqlExecutionBudget,
  sqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import { DbQueryOptions } from '@/db-query.options';
import * as loopDb from '@/db';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  MarketDepthCursorConflictError,
  MarketDepthDb,
  marketDepthDb,
  StaleMarketDepthSnapshotError
} from './market-depth.db';
import {
  AppendMarketDepthEventsInput,
  MarketDepthEventInput,
  MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES,
  NormalizedMarketDepthOrder,
  PublishMarketDepthSnapshotInput
} from './market-depth.types';

const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';
const UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ObservedExecutor extends SqlExecutor {
  beforeQuery?: (
    sql: string,
    params?: Record<string, unknown>
  ) => Promise<void>;
  afterQuery?: (sql: string) => Promise<void>;

  constructor(private readonly delegate: SqlExecutor) {
    super();
  }

  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    await this.beforeQuery?.(normalized, params);
    const result = await this.delegate.execute<T>(sql, params, options);
    await this.afterQuery?.(normalized);
    return result;
  }

  executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.delegate.executeNativeQueriesInTransaction(executable, options);
  }
}

async function withObservedDb(
  adapter: 'api' | 'loop',
  run: (db: MarketDepthDb, observed: ObservedExecutor) => Promise<void>
) {
  const previous = sqlExecutor;
  try {
    if (adapter === 'loop') await loopDb.connect();
    const observed = new ObservedExecutor(sqlExecutor);
    await run(new MarketDepthDb(() => observed), observed);
  } finally {
    if (adapter === 'loop') {
      await loopDb.disconnect();
      setSqlExecutor(previous);
    }
  }
}

function order(
  overrides: Partial<NormalizedMarketDepthOrder> = {}
): NormalizedMarketDepthOrder {
  return {
    order_key: 'order-key-1',
    order_id: 'provider-order-1',
    source: 'opensea-rest',
    protocol: 'seaport',
    contract: CONTRACT,
    collection_slug: 'project-a',
    token_id: '1',
    side: 'ask',
    status: 'ACTIVE',
    is_private: false,
    scope: 'token',
    maker: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    original_quantity: '1',
    remaining_quantity: '1',
    currency_contract: null,
    currency_symbol: 'ETH',
    currency_decimals: 18,
    current_price_raw: '1000000000000000000',
    current_price_decimal: '1',
    unit_price_decimal: '1',
    start_at: new Date('2026-09-10T00:00:00.000Z'),
    end_at: new Date('2026-09-11T00:00:00.000Z'),
    observed_at: new Date('2026-09-10T00:01:00.000Z'),
    source_url: null,
    criteria: { token_id: '1' },
    protocol_data: null,
    source_data: { preserved: true },
    is_executable: true,
    executable_caveats: [],
    ...overrides
  };
}

function snapshot(
  id: string,
  overrides: Partial<PublishMarketDepthSnapshotInput> = {}
): PublishMarketDepthSnapshotInput {
  return {
    id,
    source: 'opensea-rest',
    contract: CONTRACT,
    collection_slug: 'project-a',
    collection_id: null,
    started_at: new Date('2026-09-10T00:00:00.000Z'),
    completed_at: new Date('2026-09-10T00:01:00.000Z'),
    normalizer_version: 'test-v1',
    raw_order_count: 1,
    unsupported_count: 0,
    skipped_count: 0,
    event_count: 0,
    raw_archive_gzip: gzipSync(JSON.stringify({ raw: true })),
    normalized_archive_gzip: gzipSync(JSON.stringify({ normalized: true })),
    orders: [order()],
    ...overrides
  };
}

function event(overrides: Partial<MarketDepthEventInput> = {}) {
  return {
    event_id: 'event-1',
    kind: 'order_created',
    source: 'opensea-stream',
    source_evidence: 'stream',
    provider_at: new Date('2026-09-10T00:00:00.000Z'),
    observed_at: new Date('2026-09-10T00:00:01.000Z'),
    order_id: 'provider-order-1',
    contract: CONTRACT,
    collection_slug: 'project-a',
    token_id: UINT256,
    maker: null,
    taker: null,
    quantity: UINT256,
    currency_contract: null,
    currency_symbol: 'ETH',
    currency_decimals: 18,
    price_raw: UINT256,
    price_decimal: null,
    transaction_hash: null,
    raw: { exact: UINT256 },
    ...overrides
  } satisfies MarketDepthEventInput;
}

function eventPage(): AppendMarketDepthEventsInput {
  return {
    source: 'opensea-stream',
    contract: CONTRACT,
    collection_slug: 'project-a',
    expected_cursor: null,
    expected_watermark: null,
    next_cursor: 'page-2',
    provider_watermark: 'window-100',
    provider_at: new Date('2026-09-10T00:00:00.000Z'),
    observed_at: new Date('2026-09-10T00:00:01.000Z'),
    events: [event()]
  };
}

function eventBudget(statementMillis = 200): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: performance.now() + 3000,
    maxStatementMillis: statementMillis,
    finalizationReserveMillis: 1000,
    lockWaitSeconds: 3
  };
}

describeWithSeed('MarketDepthDb', [] as never[], () => {
  it.each(['api', 'loop'] as const)(
    'cancels a cursor-blocked event save and can retry safely through the %s adapter',
    async (adapter) => {
      const observer = sqlExecutor;
      await withObservedDb(adapter, async (db) => {
        const page = eventPage();
        await db.appendEvents({
          ...page,
          next_cursor: null,
          provider_watermark: null,
          events: []
        });
        const locked = deferred();
        const release = deferred();
        const blocker = observer.executeNativeQueriesInTransaction(
          async (connection) => {
            await observer.execute(
              "SELECT source FROM market_depth_cursors WHERE source=:source AND chain_id='1' AND contract=:contract AND collection_slug=:collection_slug FOR UPDATE",
              { ...page },
              { wrappedConnection: connection }
            );
            locked.resolve();
            await release.promise;
          }
        );
        try {
          await locked.promise;
          const started = performance.now();
          await expect(
            db.appendEvents(page, eventBudget())
          ).rejects.toMatchObject({
            phase: 'WORK',
            commitOutcome: 'NOT_SENT',
            connectionDestroyed: true
          });
          expect(performance.now() - started).toBeLessThan(2000);
        } finally {
          release.resolve();
          await blocker;
        }
        expect(
          await db.getCursor(page.source, page.contract, page.collection_slug)
        ).toMatchObject({
          provider_cursor: null,
          provider_watermark: null
        });
        // Replays after disposal use a healthy connection and preserve global uniqueness.
        await db.appendEvents(page, eventBudget(1000));
        await db.appendEvents(
          {
            ...page,
            expected_cursor: page.next_cursor,
            expected_watermark: page.provider_watermark
          },
          eventBudget(1000)
        );
        const count = await observer.execute<{ count: number }>(
          'SELECT COUNT(*) AS count FROM market_depth_events'
        );
        expect(Number(count[0].count)).toBe(1);
      });
    }
  );

  it.each(['api', 'loop'] as const)(
    'rolls back inserted events and cursor progress when a later statement stalls through the %s adapter',
    async (adapter) => {
      const observer = sqlExecutor;
      await withObservedDb(adapter, async (db, observed) => {
        const page = eventPage();
        await db.appendEvents({
          ...page,
          next_cursor: null,
          provider_watermark: null,
          events: []
        });
        const execute = jest.spyOn(observed, 'execute');
        observed.afterQuery = async (sql) => {
          if (!sql.startsWith('INSERT IGNORE INTO market_depth_events')) return;
          // The bound transaction has inserted the events, but has not advanced its cursor.
          const options = execute.mock.calls.find(([statement]) =>
            statement.includes('INSERT IGNORE INTO market_depth_events')
          )?.[2];
          await observed.execute('SELECT SLEEP(2)', undefined, options);
        };
        try {
          await expect(
            db.appendEvents(page, eventBudget())
          ).rejects.toMatchObject({
            phase: 'WORK',
            commitOutcome: 'NOT_SENT',
            connectionDestroyed: true
          });
          expect(
            execute.mock.calls.some(([sql]) =>
              sql.startsWith('UPDATE market_depth_cursors')
            )
          ).toBe(false);
          observed.afterQuery = undefined;
          expect(
            await db.getCursor(page.source, page.contract, page.collection_slug)
          ).toMatchObject({
            provider_cursor: null,
            provider_watermark: null
          });
          const count = await observer.execute<{ count: number }>(
            'SELECT COUNT(*) AS count FROM market_depth_events'
          );
          expect(Number(count[0].count)).toBe(0);
          await db.appendEvents(page, eventBudget(1000));
        } finally {
          observed.afterQuery = undefined;
          execute.mockRestore();
        }
      });
    }
  );

  it.each(['api', 'loop'] as const)(
    'serializes populated collections and measures waiting separately from saving through the %s adapter',
    async (adapter) => {
      await withObservedDb(adapter, async (db, observed) => {
        const first = snapshot('00000000-0000-4000-8000-000000000101', {
          orders: Array.from({ length: 503 }, (_, i) =>
            order({ order_key: `a-${i}`, order_id: `a-${i}` })
          )
        });
        const second = snapshot('00000000-0000-4000-8000-000000000102', {
          contract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          collection_slug: 'project-b',
          orders: Array.from({ length: 1503 }, (_, i) =>
            order({ order_key: `b-${i}`, order_id: `b-${i}` })
          )
        });
        await db.publishCompletedSnapshot(first);
        await db.publishCompletedSnapshot(second);
        const deleted = deferred();
        const secondAttemptedLock = deferred();
        const release = deferred();
        let lockAttempts = 0;
        const lockIds: unknown[] = [];
        let deletes = 0;
        observed.beforeQuery = async (sql, params) => {
          if (sql.startsWith('INSERT INTO market_depth_publication_locks')) {
            lockIds.push(params?.id);
            if (++lockAttempts === 2) secondAttemptedLock.resolve();
          }
        };
        observed.afterQuery = async (sql) => {
          if (sql.startsWith('DELETE FROM market_depth_current_orders')) {
            if (++deletes === 1) {
              deleted.resolve();
              await release.promise;
            }
          }
        };
        const info = jest.spyOn(Logger.get('MARKET_DEPTH_DB'), 'info');
        const timeout = setTimeout(() => {
          deleted.resolve();
          secondAttemptedLock.resolve();
          release.resolve();
        }, 5000);
        const replacements = [first, second].map((input, index) => ({
          ...input,
          id: `00000000-0000-4000-8000-00000000011${index}`,
          started_at: new Date('2026-09-10T00:02:00.000Z'),
          completed_at: new Date('2026-09-10T00:03:00.000Z')
        }));
        const firstSave = db.publishCompletedSnapshot(replacements[0]);
        let secondSave: Promise<unknown> | undefined;
        try {
          await deleted.promise;
          secondSave = db.publishCompletedSnapshot(replacements[1]);
          await secondAttemptedLock.promise;
          // Readers retain the old complete book while another collection waits.
          const current = await db.getLatestCompletedSnapshot(
            second.source,
            second.contract,
            second.collection_slug
          );
          expect(current?.snapshot.id).toBe(second.id);
          expect(current?.orders).toHaveLength(1503);
          expect(deletes).toBe(1);
          expect(lockIds).toHaveLength(2);
          expect(typeof lockIds[0]).toBe('string');
          expect(lockIds[1]).toBe(lockIds[0]);
          release.resolve();
          await Promise.all([firstSave, secondSave]);
          expect(deletes).toBe(2);
          for (const input of replacements) {
            const published = await db.getLatestCompletedSnapshot(
              input.source,
              input.contract,
              input.collection_slug
            );
            expect(published?.snapshot.id).toBe(input.id);
            expect(published?.orders).toHaveLength(input.orders.length);
          }
          const timing = info.mock.calls
            .filter(([message]) => message === '[SNAPSHOT PUBLICATION]')
            .map(([, data]) => data);
          expect(timing).toHaveLength(2);
          const firstTiming = timing.find(
            (entry) => entry.snapshot_id === replacements[0].id
          );
          const secondTiming = timing.find(
            (entry) => entry.snapshot_id === replacements[1].id
          );
          expect(secondTiming).toMatchObject({
            outcome: 'committed',
            phase: 'commit',
            lock_acquired: true,
            snapshot_id: replacements[1].id,
            order_count: 1503,
            lock_wait_ms: expect.any(Number),
            lock_held_ms: expect.any(Number),
            insert_ms: expect.any(Number),
            total_ms: expect.any(Number)
          });
          expect(secondTiming.lock_wait_ms).toBeGreaterThanOrEqual(0);
          expect(firstTiming.lock_held_ms).toBeGreaterThanOrEqual(0);
          expect(secondTiming.insert_ms).toBeLessThanOrEqual(
            secondTiming.lock_held_ms
          );
          expect(secondTiming).not.toHaveProperty('orders');
        } finally {
          clearTimeout(timeout);
          release.resolve();
          await Promise.allSettled([firstSave, secondSave]);
          info.mockRestore();
        }
      });
    }
  );

  it('publishes four populated books together and records their serialized save costs', async () => {
    const counts = [10000, 1500, 500, 503];
    const inputs = counts.map((count, collection) =>
      snapshot(`00000000-0000-4000-8000-00000000013${collection}`, {
        contract: `0x${String(collection + 1).repeat(40)}`,
        collection_slug: `load-test-${collection}`,
        orders: Array.from({ length: count }, (_, i) =>
          order({
            order_key: createHash('sha256')
              .update(`${collection}/${i}`)
              .digest('hex'),
            order_id: `${collection}/${i}`
          })
        )
      })
    );
    await Promise.all(
      inputs.map((input) => marketDepthDb.publishCompletedSnapshot(input))
    );
    const lockRows = await sqlExecutor.execute<{ count: number }>(
      'SELECT COUNT(*) AS count FROM market_depth_publication_locks'
    );
    expect(Number(lockRows[0].count)).toBe(1);
    const info = jest.spyOn(Logger.get('MARKET_DEPTH_DB'), 'info');
    try {
      const replacements = inputs.map((input, index) => ({
        ...input,
        id: `00000000-0000-4000-8000-00000000014${index}`,
        started_at: new Date('2026-09-10T00:02:00.000Z'),
        completed_at: new Date('2026-09-10T00:03:00.000Z')
      }));
      await Promise.all(
        replacements.map((input) =>
          marketDepthDb.publishCompletedSnapshot(input)
        )
      );
      const timings = info.mock.calls
        .filter(([message]) => message === '[SNAPSHOT PUBLICATION]')
        .map(([, data]) => ({
          order_count: data.order_count,
          lock_wait_ms: data.lock_wait_ms,
          lock_held_ms: data.lock_held_ms,
          insert_ms: data.insert_ms,
          lock_wait_timeout_s: data.lock_wait_timeout_s,
          outcome: data.outcome
        }));
      expect(timings).toHaveLength(4);
      for (const timing of timings) {
        expect(timing).toMatchObject({
          outcome: 'committed',
          lock_wait_timeout_s: expect.any(Number)
        });
      }
      // Diagnostic measurements only; do not assert environment-specific latency.
      process.stdout.write(
        `Snapshot concurrency timings (synthetic MySQL): ${JSON.stringify(timings)}\n`
      );
      for (const input of replacements) {
        const current = await marketDepthDb.getLatestCompletedSnapshot(
          input.source,
          input.contract,
          input.collection_slug
        );
        expect(current?.snapshot.id).toBe(input.id);
        expect(current?.orders).toHaveLength(input.orders.length);
      }
    } finally {
      info.mockRestore();
    }
  });

  it.each(['api', 'loop'] as const)(
    'logs a lock-acquisition failure and rolls back the staged archive through the %s adapter',
    async (adapter) => {
      await withObservedDb(adapter, async (db, observed) => {
        observed.beforeQuery = async (sql) => {
          if (sql.startsWith('INSERT INTO market_depth_publication_locks')) {
            throw new Error('synthetic lock acquisition failure');
          }
        };
        const input = snapshot('00000000-0000-4000-8000-000000000150');
        const info = jest.spyOn(Logger.get('MARKET_DEPTH_DB'), 'info');
        try {
          await expect(db.publishCompletedSnapshot(input)).rejects.toThrow(
            'synthetic lock acquisition failure'
          );
          expect(info).toHaveBeenCalledWith(
            '[SNAPSHOT PUBLICATION]',
            expect.objectContaining({
              outcome: 'error',
              phase: 'lock',
              lock_acquired: false,
              lock_wait_ms: expect.any(Number),
              lock_held_ms: null,
              insert_ms: null
            })
          );
          expect(await db.getSnapshotArchive(input.id)).toBeNull();
          expect(
            await db.getLatestCompletedSnapshot(
              input.source,
              input.contract,
              input.collection_slug
            )
          ).toBeNull();
        } finally {
          info.mockRestore();
        }
      });
    }
  );

  it.each(['api', 'loop'] as const)(
    'releases the shared lock after a partially inserted replacement rolls back through the %s adapter',
    async (adapter) => {
      await withObservedDb(adapter, async (db, observed) => {
        const first = snapshot('00000000-0000-4000-8000-000000000120');
        await db.publishCompletedSnapshot(first);
        let failInsert = true;
        observed.afterQuery = async (sql) => {
          if (
            failInsert &&
            sql.startsWith('INSERT INTO market_depth_current_orders')
          ) {
            failInsert = false;
            throw new Error('synthetic failure after insertion');
          }
        };
        const info = jest.spyOn(Logger.get('MARKET_DEPTH_DB'), 'info');
        try {
          await expect(
            db.publishCompletedSnapshot({
              ...first,
              id: '00000000-0000-4000-8000-000000000121',
              started_at: new Date('2026-09-10T00:02:00.000Z'),
              completed_at: new Date('2026-09-10T00:03:00.000Z'),
              orders: [order({ order_key: 'new', order_id: 'new' })]
            })
          ).rejects.toThrow('synthetic failure after insertion');
          expect(info).toHaveBeenCalledWith(
            '[SNAPSHOT PUBLICATION]',
            expect.objectContaining({
              outcome: 'error',
              phase: 'insert_orders',
              lock_acquired: true,
              lock_wait_ms: expect.any(Number),
              lock_held_ms: expect.any(Number),
              insert_ms: expect.any(Number)
            })
          );
          const current = await db.getLatestCompletedSnapshot(
            first.source,
            first.contract,
            first.collection_slug
          );
          expect(current?.snapshot.id).toBe(first.id);
          expect(current?.orders[0].order_key).toBe('order-key-1');
          expect(
            await db.getSnapshotArchive('00000000-0000-4000-8000-000000000121')
          ).toBeNull();
          await expect(
            db.publishCompletedSnapshot(
              snapshot('00000000-0000-4000-8000-000000000122', {
                contract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                collection_slug: 'project-b',
                orders: [order({ order_key: 'b', order_id: 'b' })]
              })
            )
          ).resolves.toMatchObject({
            id: '00000000-0000-4000-8000-000000000122'
          });
        } finally {
          info.mockRestore();
        }
      });
    }
  );

  it.each(['api', 'loop'] as const)(
    'serializes concurrent publication of the same collection through the %s adapter',
    async (adapter) => {
      await withObservedDb(adapter, async (db) => {
        const first = snapshot('00000000-0000-4000-8000-000000000103');
        const second = { ...first, id: '00000000-0000-4000-8000-000000000104' };
        const results = await Promise.allSettled([
          db.publishCompletedSnapshot(first),
          db.publishCompletedSnapshot(second)
        ]);
        const committed = results.filter(
          (result) => result.status === 'fulfilled'
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected'
        );
        expect(committed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(
          StaleMarketDepthSnapshotError
        );
        const current = await db.getLatestCompletedSnapshot(
          first.source,
          first.contract,
          first.collection_slug
        );
        expect(current?.snapshot.id).toBe(committed[0].value.id);
        expect(current?.orders).toHaveLength(1);
      });
    }
  );

  it.each(['api', 'loop'] as const)(
    'keeps metadata and orders in one read snapshot during a replacement through the %s adapter',
    async (adapter) => {
      await withObservedDb(adapter, async (db, observed) => {
        const first = snapshot('00000000-0000-4000-8000-000000000105');
        await db.publishCompletedSnapshot(first);
        let replaced = false;
        observed.afterQuery = async (sql) => {
          if (replaced || !sql.startsWith('SELECT s.id,')) return;
          replaced = true;
          await db.publishCompletedSnapshot(
            snapshot('00000000-0000-4000-8000-000000000106', {
              started_at: new Date('2026-09-10T01:00:00.000Z'),
              completed_at: new Date('2026-09-10T01:01:00.000Z'),
              orders: [
                order({ order_key: 'replacement', order_id: 'replacement' })
              ]
            })
          );
        };
        const current = await db.getLatestCompletedSnapshot(
          first.source,
          first.contract,
          first.collection_slug
        );
        expect(replaced).toBe(true);
        expect(current?.snapshot.id).toBe(first.id);
        expect(current?.orders.map((item) => item.order_key)).toEqual([
          'order-key-1'
        ]);
      });
    }
  );

  it('rejects archives that cannot fit safely in the configured SQL packet', async () => {
    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000000', {
          raw_archive_gzip: Buffer.concat([
            Buffer.from([0x1f, 0x8b]),
            Buffer.alloc(MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES / 2 - 1)
          ]),
          normalized_archive_gzip: Buffer.concat([
            Buffer.from([0x1f, 0x8b]),
            Buffer.alloc(MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES / 2 - 1)
          ])
        })
      )
    ).rejects.toThrow('combined compressed archive limit');
  });

  it('rolls back a failed replacement and retains the last complete book', async () => {
    const first = snapshot('00000000-0000-4000-8000-000000000001');
    await marketDepthDb.publishCompletedSnapshot(first);

    const duplicateProviderOrder = order({
      order_key: 'different-key',
      order_id: first.orders[0].order_id
    });
    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000002', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T01:01:00.000Z'),
          raw_order_count: 2,
          orders: [first.orders[0], duplicateProviderOrder]
        })
      )
    ).rejects.toThrow();

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      first.source,
      first.contract,
      first.collection_slug
    );
    expect(current?.snapshot.id).toBe(first.id);
    expect(current?.orders.map((item) => item.order_key)).toEqual([
      'order-key-1'
    ]);
    const archive = await marketDepthDb.getSnapshotArchive(first.id);
    expect(Buffer.isBuffer(archive?.raw_archive_gzip)).toBe(true);
    expect(archive?.raw_archive_gzip.subarray(0, 2)).toEqual(
      Buffer.from([0x1f, 0x8b])
    );
  });

  it('rolls back publication when its durable reconciliation enqueue fails', async () => {
    const first = snapshot('00000000-0000-4000-8000-000000000010');
    await marketDepthDb.publishCompletedSnapshot(first);

    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000011', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T01:01:00.000Z'),
          orders: [
            order({ order_key: 'replacement', order_id: 'replacement' })
          ],
          reconciliations: [
            {
              prior_snapshot_id: first.id,
              source: first.source,
              contract: first.contract,
              collection_slug: first.collection_slug,
              missing_at: new Date('2026-09-10T01:01:00.000Z'),
              order: order({
                source_data: BigInt(1) as unknown as Record<string, never>
              })
            }
          ]
        })
      )
    ).rejects.toThrow();

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      first.source,
      first.contract,
      first.collection_slug
    );
    expect(current?.snapshot.id).toBe(first.id);
    const queues = await sqlExecutor.execute<{ count: number }>(
      'SELECT COUNT(*) AS count FROM market_depth_reconciliation_queue'
    );
    expect(Number(queues[0].count)).toBe(0);
  });

  it('rejects an older-started overlapping poll even if it finishes later', async () => {
    const newer = snapshot('00000000-0000-4000-8000-000000000003', {
      started_at: new Date('2026-09-10T02:00:00.000Z'),
      completed_at: new Date('2026-09-10T02:01:00.000Z')
    });
    await marketDepthDb.publishCompletedSnapshot(newer);

    await expect(
      marketDepthDb.publishCompletedSnapshot(
        snapshot('00000000-0000-4000-8000-000000000004', {
          started_at: new Date('2026-09-10T01:00:00.000Z'),
          completed_at: new Date('2026-09-10T03:00:00.000Z')
        })
      )
    ).rejects.toBeInstanceOf(StaleMarketDepthSnapshotError);
  });

  it('keeps project partitions independent and excludes wrong-snapshot rows', async () => {
    const projectA = snapshot('00000000-0000-4000-8000-000000000005');
    const projectB = snapshot('00000000-0000-4000-8000-000000000006', {
      collection_slug: 'project-b',
      collection_id: 2,
      orders: [
        order({
          order_key: 'project-b-order',
          order_id: 'project-b-order',
          collection_slug: 'project-b'
        })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(projectA);
    await marketDepthDb.publishCompletedSnapshot(projectB);

    await sqlExecutor.execute(
      `INSERT INTO market_depth_current_orders
       SELECT 'stale-row', :oldSnapshotId, chain, chain_id, 'stale-order',
              source, protocol, contract, collection_slug, token_id, side,
              status, is_private, scope, maker, original_quantity,
              remaining_quantity, currency_contract, currency_symbol,
              currency_decimals, current_price_raw, current_price_decimal,
              unit_price_decimal, start_at, end_at, observed_at, source_url,
              criteria, protocol_data, source_data, is_executable,
              executable_caveats
       FROM market_depth_current_orders WHERE order_key='project-b-order'`,
      { oldSnapshotId: projectA.id }
    );

    const currentB = await marketDepthDb.getLatestCompletedSnapshot(
      projectB.source,
      projectB.contract,
      projectB.collection_slug
    );
    expect(currentB?.snapshot.collection_id).toBe(2);
    expect(currentB?.orders.map((item) => item.order_key)).toEqual([
      'project-b-order'
    ]);

    await marketDepthDb.publishCompletedSnapshot(
      snapshot('00000000-0000-4000-8000-000000000007', {
        started_at: new Date('2026-09-10T04:00:00.000Z'),
        completed_at: new Date('2026-09-10T04:01:00.000Z'),
        orders: [],
        raw_order_count: 0
      })
    );
    expect(
      await marketDepthDb.getLatestCompletedSnapshot(
        projectB.source,
        projectB.contract,
        projectB.collection_slug
      )
    ).toEqual(currentB);
  });

  it('round-trips uint256 identifiers, quantities, and raw prices as strings', async () => {
    const exact = snapshot('00000000-0000-4000-8000-000000000008', {
      raw_order_count: 3,
      orders: [
        order({
          token_id: UINT256,
          status: 'INACTIVE',
          is_private: true,
          original_quantity: UINT256,
          remaining_quantity: UINT256,
          current_price_raw: UINT256
        }),
        order({
          order_key: 'order-key-2',
          order_id: 'provider-order-2',
          token_id: '2'
        }),
        order({
          order_key: 'order-key-collection',
          order_id: 'provider-order-collection',
          token_id: null,
          scope: 'collection'
        })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(exact);

    const current = await marketDepthDb.getLatestCompletedSnapshot(
      exact.source,
      exact.contract,
      exact.collection_slug
    );
    expect(current?.orders[0]).toMatchObject({
      token_id: UINT256,
      status: 'INACTIVE',
      is_private: true,
      original_quantity: UINT256,
      remaining_quantity: UINT256,
      current_price_raw: UINT256
    });
    const compact = await marketDepthDb.getLatestCompletedSnapshot(
      exact.source,
      exact.contract,
      exact.collection_slug,
      { token_id: UINT256, include_payloads: false }
    );
    expect(compact?.orders[0]).toMatchObject({
      criteria: { token_id: '1' },
      protocol_data: null,
      source_data: null
    });
    expect(compact?.orders.map(({ order_key }) => order_key)).toEqual([
      'order-key-1',
      'order-key-collection'
    ]);
  });

  it('bounds collection ask reads without including bids or changing the snapshot counts', async () => {
    const published = snapshot('00000000-0000-4000-8000-000000000099', {
      raw_order_count: 3,
      orders: [
        order(),
        order({ order_key: 'ask-two', order_id: 'ask-two' }),
        order({ order_key: 'bid-one', order_id: 'bid-one', side: 'bid' })
      ]
    });
    await marketDepthDb.publishCompletedSnapshot(published);
    const current = await marketDepthDb.getLatestCompletedSnapshot(
      published.source,
      published.contract,
      published.collection_slug,
      { side: 'ask', limit: 1 }
    );
    expect(current?.orders).toHaveLength(1);
    expect(current?.orders[0].side).toBe('ask');
    expect(current?.snapshot).toMatchObject({ ask_count: 2, bid_count: 1 });
    await expect(
      marketDepthDb.getLatestCompletedSnapshot(
        published.source,
        published.contract,
        published.collection_slug,
        { side: 'ask', limit: 10002 }
      )
    ).rejects.toThrow('Invalid market-depth read limit');
  });

  it('deduplicates events and advances a cursor with cursor and watermark CAS', async () => {
    const base = {
      source: 'opensea-stream',
      contract: CONTRACT,
      collection_slug: 'project-a',
      provider_at: new Date('2026-09-10T00:00:00.000Z'),
      observed_at: new Date('2026-09-10T00:00:01.000Z'),
      events: [event()]
    };
    await marketDepthDb.appendEvents({
      ...base,
      expected_cursor: null,
      expected_watermark: null,
      next_cursor: 'page-2',
      provider_watermark: null
    });
    await marketDepthDb.appendEvents({
      ...base,
      expected_cursor: 'page-2',
      expected_watermark: null,
      next_cursor: null,
      provider_watermark: 'window-100'
    });

    const count = await sqlExecutor.execute<{ count: number }>(
      'SELECT COUNT(*) AS count FROM market_depth_events'
    );
    expect(Number(count[0].count)).toBe(1);
    const occurred = await sqlExecutor.execute<{ occurred_at: Date }>(
      'SELECT occurred_at FROM market_depth_events WHERE event_id=:eventId',
      { eventId: event().event_id }
    );
    expect(new Date(occurred[0].occurred_at)).toEqual(event().provider_at);
    expect(
      await marketDepthDb.getCursor(
        base.source,
        base.contract,
        base.collection_slug
      )
    ).toMatchObject({
      provider_cursor: null,
      provider_watermark: 'window-100'
    });

    await expect(
      marketDepthDb.appendEvents({
        ...base,
        expected_cursor: null,
        expected_watermark: null,
        next_cursor: 'stale',
        provider_watermark: null
      })
    ).rejects.toBeInstanceOf(MarketDepthCursorConflictError);
  });

  it('durably queues missing orders and resolves retries with attempt CAS', async () => {
    const missingAt = new Date('2026-09-10T02:00:00.000Z');
    const input = {
      prior_snapshot_id: '00000000-0000-4000-8000-000000000009',
      source: 'opensea-rest',
      contract: CONTRACT,
      collection_slug: 'project-a',
      missing_at: missingAt,
      order: order()
    };
    await marketDepthDb.enqueueReconciliations([input, input]);

    const pending = await marketDepthDb.getDueReconciliations(
      input.source,
      input.contract,
      input.collection_slug,
      new Date('2026-09-10T02:00:01.000Z')
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      prior_snapshot_id: input.prior_snapshot_id,
      order_id: input.order.order_id,
      order_key: input.order.order_key,
      status: 'PENDING',
      attempt_count: 0
    });
    expect(pending[0].prior_order.observed_at).toEqual(input.order.observed_at);

    const attemptedAt = new Date('2026-09-10T02:00:02.000Z');
    const nextAttemptAt = new Date('2026-09-10T02:05:00.000Z');
    expect(
      await marketDepthDb.markReconciliationRetry({
        id: pending[0].id,
        expected_attempt_count: 0,
        attempted_at: attemptedAt,
        next_attempt_at: nextAttemptAt,
        last_error: 'provider timeout'
      })
    ).toBe(true);
    expect(
      await marketDepthDb.markReconciliationRetry({
        id: pending[0].id,
        expected_attempt_count: 0,
        attempted_at: attemptedAt,
        next_attempt_at: nextAttemptAt,
        last_error: 'stale worker'
      })
    ).toBe(false);

    const retry = await marketDepthDb.getDueReconciliations(
      input.source,
      input.contract,
      input.collection_slug,
      nextAttemptAt
    );
    expect(retry[0]).toMatchObject({
      attempt_count: 1,
      last_error: 'provider timeout'
    });
    expect(
      await marketDepthDb.resolveReconciliation({
        id: retry[0].id,
        expected_attempt_count: 1,
        resolved_at: new Date('2026-09-10T02:05:01.000Z')
      })
    ).toBe(true);
    expect(
      await marketDepthDb.getDueReconciliations(
        input.source,
        input.contract,
        input.collection_slug,
        new Date('2026-09-10T03:00:00.000Z')
      )
    ).toEqual([]);
  });
});
