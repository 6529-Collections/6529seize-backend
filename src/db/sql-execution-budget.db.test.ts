import type { QueryRunner } from 'typeorm';
import { MembershipSourceStateEntity } from '@/entities/IMembershipSourceState';
import * as mysql from 'mysql';
import { performance } from 'node:perf_hooks';
import * as apiDb from '@/db-api';
import * as loopDb from '@/db';
import { MEMBERSHIP_SOURCE_STATES_TABLE } from '@/constants';
import {
  setSqlExecutor,
  SqlExecutionBudget,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import {
  assertMembershipPrimaryContext,
  membershipExecutionBudget,
  membershipQueryOptions,
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from '@/membership/membership-primary';

const first = 'm3-budget-first';
const second = 'm3-budget-second';
const query = `SELECT CAST(version AS CHAR) AS version FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} WHERE scope='PROFILE' AND target_id=:id AND dimension='IDENTITY'`;
const update = `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=version+1 WHERE scope='PROFILE' AND target_id=:id AND dimension='IDENTITY'`;
function budget(work = 1000, statement = 300): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: performance.now() + work + 1000,
    maxStatementMillis: statement,
    finalizationReserveMillis: 1000,
    lockWaitSeconds: 1
  };
}
async function physical(
  ctx: MembershipPrimaryContext,
  adapter: string
): Promise<mysql.PoolConnection> {
  return adapter === 'API'
    ? (ctx.connection.connection as mysql.PoolConnection)
    : (
        ctx.connection.connection as {
          connect(): Promise<mysql.PoolConnection>;
        }
      ).connect();
}
async function waitUntilUnlocked(db: SqlExecutor): Promise<void> {
  const deadline = performance.now() + 4000;
  while (true) {
    try {
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        await db.execute(
          `${query} FOR UPDATE NOWAIT`,
          { id: first },
          membershipQueryOptions(ctx)
        );
      });
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe.each(['API', 'LOOP'])(
  'SQL execution budget through actual %s adapter',
  (adapter) => {
    let observer: SqlExecutor;
    let db: SqlExecutor;
    beforeEach(async () => {
      observer = sqlExecutor;
      await observer.execute(
        `INSERT INTO ${MEMBERSHIP_SOURCE_STATES_TABLE} (scope,target_id,dimension,version,active_jobs,updated_at_millis) VALUES ('PROFILE',:first,'IDENTITY',1,0,1),('PROFILE',:second,'IDENTITY',1,0,1)`,
        { first, second }
      );
      if (adapter === 'API') await apiDb.connect();
      else await loopDb.connect([MembershipSourceStateEntity]);
      db = sqlExecutor;
    });
    afterEach(async () => {
      if (adapter === 'API') await apiDb.disconnect();
      else await loopDb.disconnect();
      setSqlExecutor(observer);
      await observer.execute(
        `DELETE FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} WHERE scope='PROFILE' AND target_id IN (:ids) AND dimension='IDENTITY'`,
        { ids: [first, second] }
      );
      jest.restoreAllMocks();
    });

    it('uses one physical session and restores string-valued settings after acknowledged commit', async () => {
      let connectionId: number | undefined;
      let original:
        | { execution_millis: string; lock_seconds: string }
        | undefined;
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        const rows = await db.execute<{
          connection_id: number;
          execution_millis: string;
          lock_seconds: string;
        }>(
          'SELECT CONNECTION_ID() connection_id, CAST(@@SESSION.max_execution_time AS CHAR) execution_millis, CAST(@@SESSION.innodb_lock_wait_timeout AS CHAR) lock_seconds',
          undefined,
          membershipQueryOptions(ctx)
        );
        connectionId = Number(rows[0].connection_id);
        original = rows[0];
      });
      await withMembershipPrimaryTransaction(
        db,
        async (ctx) => {
          const caps = membershipExecutionBudget(ctx);
          expect(Object.isFrozen(caps)).toBe(true);
          const row = (
            await db.execute<{
              connection_id: number;
              execution_millis: string;
              lock_seconds: string;
            }>(
              'SELECT CONNECTION_ID() connection_id, CAST(@@SESSION.max_execution_time AS CHAR) execution_millis, CAST(@@SESSION.innodb_lock_wait_timeout AS CHAR) lock_seconds',
              undefined,
              membershipQueryOptions(ctx)
            )
          )[0];
          expect(Number(row.connection_id)).toBe(connectionId);
          expect(row.execution_millis).toBe('300');
          expect(row.lock_seconds).toBe('1');
          await db.execute(update, { id: first }, membershipQueryOptions(ctx));
        },
        {},
        budget()
      );
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        const restored = (
          await db.execute<{
            connection_id: number;
            execution_millis: string;
            lock_seconds: string;
          }>(
            'SELECT CONNECTION_ID() connection_id, CAST(@@SESSION.max_execution_time AS CHAR) execution_millis, CAST(@@SESSION.innodb_lock_wait_timeout AS CHAR) lock_seconds',
            undefined,
            membershipQueryOptions(ctx)
          )
        )[0];
        expect(Number(restored.connection_id)).toBe(connectionId);
        expect(restored.execution_millis).toBe(original!.execution_millis);
        expect(restored.lock_seconds).toBe(original!.lock_seconds);
      });
      expect(await observer.execute(query, { id: first })).toEqual([
        { version: '2' }
      ]);
    });

    it('restores sessions after ordinary work failure without committing earlier writes', async () => {
      const failure = new Error('intentional rollback');
      let connection: mysql.PoolConnection | undefined;
      let original: unknown;
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        original = await db.execute(
          'SELECT CAST(@@SESSION.max_execution_time AS CHAR) cap, CAST(@@SESSION.innodb_lock_wait_timeout AS CHAR) lock_seconds',
          undefined,
          membershipQueryOptions(ctx)
        );
      });
      await expect(
        withMembershipPrimaryTransaction(
          db,
          async (ctx) => {
            connection = await physical(ctx, adapter);
            await db.execute(
              update,
              { id: first },
              membershipQueryOptions(ctx)
            );
            throw failure;
          },
          {},
          budget()
        )
      ).rejects.toBe(failure);
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        expect(await physical(ctx, adapter)).toBe(connection);
        expect(
          await db.execute(
            'SELECT CAST(@@SESSION.max_execution_time AS CHAR) cap, CAST(@@SESSION.innodb_lock_wait_timeout AS CHAR) lock_seconds',
            undefined,
            membershipQueryOptions(ctx)
          )
        ).toEqual(original);
      });
      expect(await observer.execute(query, { id: first })).toEqual([
        { version: '1' }
      ]);
    });

    it('aborts a SELECT, settles its promise and rolls back an earlier write even when the callback catches it', async () => {
      let context: MembershipPrimaryContext | undefined;
      let destroyed: jest.SpyInstance | undefined;
      const began = performance.now();
      await expect(
        withMembershipPrimaryTransaction(
          db,
          async (ctx) => {
            context = ctx;
            destroyed = jest.spyOn(await physical(ctx, adapter), 'destroy');
            const options = membershipQueryOptions(ctx, {
              maxStatementMillis: 80,
              deadlineMonotonicMillis: performance.now() + 600
            });
            await db.execute(update, { id: first }, options);
            try {
              await db.execute('SELECT SLEEP(2)', undefined, options);
            } catch {
              /* Cannot turn timeout into commit. */
            }
            return 'caught';
          },
          {},
          budget()
        )
      ).rejects.toMatchObject({
        commitOutcome: 'NOT_SENT',
        connectionDestroyed: true
      });
      expect(performance.now() - began).toBeLessThan(1500);
      // mysql Pool._purgeConnection re-enters PoolConnection.destroy once.
      expect(destroyed).toHaveBeenCalledTimes(2);
      expect(() => assertMembershipPrimaryContext(context!)).toThrow(
        'active primary'
      );
      await waitUntilUnlocked(observer);
      expect(await observer.execute(query, { id: first })).toEqual([
        { version: '1' }
      ]);
      await withMembershipPrimaryTransaction(
        db,
        async (ctx) => {
          expect(
            await db.execute(
              'SELECT CAST(1 AS CHAR) AS healthy',
              undefined,
              membershipQueryOptions(ctx)
            )
          ).toEqual([{ healthy: '1' }]);
        },
        {},
        budget()
      );
    });

    it('bounds an idle callback and releases its real transaction locks', async () => {
      let context: MembershipPrimaryContext | undefined;
      await expect(
        withMembershipPrimaryTransaction(
          db,
          async (ctx) => {
            context = ctx;
            await db.execute(
              update,
              { id: first },
              membershipQueryOptions(ctx)
            );
            return new Promise<never>(() => undefined);
          },
          {},
          budget(150)
        )
      ).rejects.toMatchObject({
        phase: 'WORK',
        commitOutcome: 'NOT_SENT',
        connectionDestroyed: true
      });
      expect(() => assertMembershipPrimaryContext(context!)).toThrow(
        'active primary'
      );
      await waitUntilUnlocked(observer);
      expect(await observer.execute(query, { id: first })).toEqual([
        { version: '1' }
      ]);
    });

    it('bounds acquisition from a saturated real primary pool and releases late acquisition unused', async () => {
      const capacity = adapter === 'API' ? 5 : 10;
      let count = 0;
      let acquired: () => void = () => undefined;
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holders = Array.from({ length: capacity }, () =>
        withMembershipPrimaryTransaction(db, async () => {
          count++;
          if (count === capacity) acquired();
          await hold;
        })
      );
      const callback = jest.fn();
      try {
        await ready;
        await expect(
          withMembershipPrimaryTransaction(db, callback, {}, budget(40))
        ).rejects.toMatchObject({
          phase: 'ACQUIRE',
          commitOutcome: 'NOT_SENT'
        });
        expect(callback).not.toHaveBeenCalled();
      } finally {
        release();
        await Promise.all(holders);
      }
      await withMembershipPrimaryTransaction(
        db,
        async (ctx) => {
          expect(
            await db.execute(
              'SELECT CAST(1 AS CHAR) AS healthy',
              undefined,
              membershipQueryOptions(ctx)
            )
          ).toEqual([{ healthy: '1' }]);
        },
        {},
        budget()
      );
      expect(callback).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'rolls back lock contention and releases independent locks (NOWAIT=%s)',
      async (nowait) => {
        let unblock: () => void = () => undefined;
        let locked: () => void = () => undefined;
        const ready = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const blocker = withMembershipPrimaryTransaction(
          observer,
          async (ctx) => {
            await observer.execute(
              `${query} FOR UPDATE`,
              { id: second },
              membershipQueryOptions(ctx)
            );
            locked();
            await hold;
          }
        );
        await ready;
        try {
          await expect(
            withMembershipPrimaryTransaction(
              db,
              async (ctx) => {
                const options = membershipQueryOptions(ctx);
                await db.execute(update, { id: first }, options);
                await db.execute(
                  nowait ? `${query} FOR UPDATE NOWAIT` : update,
                  { id: second },
                  options
                );
              },
              {},
              budget(1000, 80)
            )
          ).rejects.toMatchObject({
            phase: 'WORK',
            commitOutcome: 'NOT_SENT',
            connectionDestroyed: !nowait,
            ...(nowait ? { serverCode: 'ER_LOCK_NOWAIT' } : {})
          });
        } finally {
          unblock();
          await blocker;
        }
        await waitUntilUnlocked(observer);
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '1' }
        ]);
        expect(await observer.execute(query, { id: second })).toEqual([
          { version: '1' }
        ]);
      }
    );

    it('reports UNKNOWN after a real COMMIT whose acknowledgment is withheld, then reconciles committed data', async () => {
      let connection: mysql.PoolConnection | undefined;
      // Intercept the original physical method before the budget installs its wrapper.
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        connection = await physical(ctx, adapter);
      });
      const original = connection!.query;
      connection!.query = function (
        this: mysql.PoolConnection,
        ...args: unknown[]
      ) {
        const input = args[0] as string | { sql: string };
        const sql = typeof input === 'string' ? input : input.sql;
        if (sql === 'COMMIT') {
          args[args.length - 1] = () => undefined; // Server commits; driver acknowledgment is suppressed.
        }
        return Reflect.apply(original!, this, args);
      } as mysql.PoolConnection['query'];
      try {
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
            },
            {},
            budget(1000, 80)
          )
        ).rejects.toMatchObject({
          phase: 'COMMIT',
          commitOutcome: 'UNKNOWN',
          connectionDestroyed: true
        });
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '2' }
        ]);
      } finally {
        connection!.query = original;
      }
    });

    it('preserves real acknowledged commit when session restoration acknowledgment is withheld', async () => {
      let connection: mysql.PoolConnection | undefined;
      await withMembershipPrimaryTransaction(db, async (ctx) => {
        connection = await physical(ctx, adapter);
      });
      const original = connection!.query;
      let sawCommit = false;
      connection!.query = function (
        this: mysql.PoolConnection,
        ...args: unknown[]
      ) {
        const input = args[0] as string | { sql: string };
        const sql = typeof input === 'string' ? input : input.sql;
        if (sql === 'COMMIT') sawCommit = true;
        if (sawCommit && sql.startsWith('SET SESSION max_execution_time'))
          args[args.length - 1] = () => undefined;
        return Reflect.apply(original, this, args);
      } as mysql.PoolConnection['query'];
      const destroy = jest.spyOn(connection!, 'destroy');
      try {
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              return 'committed';
            },
            {},
            budget(1000, 80)
          )
        ).resolves.toBe('committed');
        // mysql Pool._purgeConnection re-enters PoolConnection.destroy once.
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '2' }
        ]);
      } finally {
        connection!.query = original;
      }
    });
    if (adapter === 'LOOP') {
      it('keeps ORM manager.save and nested savepoints inside the actual outer transaction', async () => {
        const failure = new Error('rollback outer');
        let runner: QueryRunner | undefined;
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              runner = ctx.connection.connection as QueryRunner;
              expect(runner.isTransactionActive).toBe(true);
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              await runner.manager.save(MembershipSourceStateEntity, {
                scope: 'PROFILE',
                target_id: second,
                dimension: 'IDENTITY',
                version: '9',
                active_jobs: 0,
                updated_at_millis: '1'
              });
              await runner.startTransaction();
              await runner.query('SELECT 1');
              await runner.commitTransaction();
              expect(runner.isTransactionActive).toBe(true);
              throw failure;
            },
            {},
            budget()
          )
        ).rejects.toBe(failure);
        expect(runner!.isTransactionActive).toBe(false);
        expect(runner!.isReleased).toBe(true);
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '1' }
        ]);
        expect(await observer.execute(query, { id: second })).toEqual([
          { version: '1' }
        ]);
      });

      it('rejects caller outer commit before send and rolls back an earlier write', async () => {
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              await (
                ctx.connection.connection as QueryRunner
              ).commitTransaction();
            },
            {},
            budget()
          )
        ).rejects.toMatchObject({
          code: 'SQL_TRANSACTION_CONTROL',
          commitOutcome: 'NOT_SENT'
        });
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '1' }
        ]);
      });

      it('does not mistake a BeforeCommit subscriber SELECT for an acknowledged COMMIT', async () => {
        const failure = new Error('before commit failed');
        loopDb.getDataSource().subscribers.push({
          beforeTransactionCommit: async ({ queryRunner }) => {
            await queryRunner.query('SELECT 1');
            throw failure;
          }
        });
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              return 'uncommitted';
            },
            {},
            budget()
          )
        ).rejects.toBe(failure);
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '1' }
        ]);
      });

      it.each([
        'beforeTransactionStart',
        'beforeTransactionCommit',
        'beforeTransactionRollback'
      ] as const)('bounds suppressed %s subscribers', async (hook) => {
        loopDb.getDataSource().subscribers.push({
          [hook]: async () => new Promise<never>(() => undefined)
        });
        const started = performance.now();
        const failWork = new Error('rollback requested');
        const operation = withMembershipPrimaryTransaction(
          db,
          async (ctx) => {
            await db.execute(
              update,
              { id: first },
              membershipQueryOptions(ctx)
            );
            if (hook === 'beforeTransactionRollback') throw failWork;
            return 'never';
          },
          {},
          {
            ...budget(100, 100),
            finalizationReserveMillis: 100,
            deadlineMonotonicMillis: performance.now() + 200
          }
        );
        if (hook === 'beforeTransactionRollback')
          await expect(operation).rejects.toBe(failWork);
        else
          await expect(operation).rejects.toMatchObject({
            commitOutcome: 'NOT_SENT',
            connectionDestroyed: true
          });
        expect(performance.now() - started).toBeLessThan(1000);
        await waitUntilUnlocked(observer);
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '1' }
        ]);
      });

      it('blocks AfterCommit SQL before send while preserving the acknowledged result', async () => {
        loopDb.getDataSource().subscribers.push({
          afterTransactionCommit: async ({ queryRunner }) => {
            await queryRunner.query(
              `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=9 WHERE scope='PROFILE' AND target_id=? AND dimension='IDENTITY'`,
              [second]
            );
          }
        });
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              return 'committed';
            },
            {},
            budget()
          )
        ).resolves.toBe('committed');
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '2' }
        ]);
        expect(await observer.execute(query, { id: second })).toEqual([
          { version: '1' }
        ]);
      });

      it('preserves actual acknowledged commit when AfterCommit never returns', async () => {
        loopDb.getDataSource().subscribers.push({
          afterTransactionCommit: async () =>
            new Promise<never>(() => undefined)
        });
        await expect(
          withMembershipPrimaryTransaction(
            db,
            async (ctx) => {
              await db.execute(
                update,
                { id: first },
                membershipQueryOptions(ctx)
              );
              return 'committed';
            },
            {},
            {
              ...budget(100, 100),
              finalizationReserveMillis: 100,
              deadlineMonotonicMillis: performance.now() + 200
            }
          )
        ).resolves.toBe('committed');
        expect(await observer.execute(query, { id: first })).toEqual([
          { version: '2' }
        ]);
      });
    }
  }
);
