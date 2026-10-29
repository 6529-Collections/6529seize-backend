import type WebSocket from 'ws';
import {
  WS_CONNECTIONS_TABLE,
  WS_NOTIFICATION_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions,
  sqlExecutor
} from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { AppWebSockets } from './ws';
import { WsConnectionRepository } from './ws-connection.repository';
import { Logger } from '@/logging';
import {
  withWebSocketOperationDiagnostics,
  setWebSocketDiagnosticOperation
} from '@/api/ws/ws-operation-diagnostics';
import { setTimeout as delay } from 'node:timers/promises';

const connectionId = 'ws-atomicity-fixture';
const expiry = 3_000_000_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ObservedExecutor extends SqlExecutor {
  beforeQuery?: (sql: string, options?: DbQueryOptions) => Promise<void>;
  afterQuery?: (sql: string, rows: unknown[]) => Promise<void>;
  transactionRequested?: () => void;
  forcedIsolation?: SqlTransactionOptions['isolationLevel'];
  constructor(private readonly delegate: SqlExecutor) {
    super();
  }

  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    await this.beforeQuery?.(normalized, options);
    const result = await this.delegate.execute<T>(sql, params, options);
    await this.afterQuery?.(normalized, result);
    return result;
  }

  executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    this.transactionRequested?.();
    return this.delegate.executeNativeQueriesInTransaction(
      executable,
      this.forcedIsolation ? { isolationLevel: this.forcedIsolation } : options
    );
  }
}

function fixture() {
  const observed = new ObservedExecutor(sqlExecutor);
  const repository = new WsConnectionRepository(
    () => observed,
    {} as never,
    () => false
  );
  return { observed, repository, sockets: new AppWebSockets(repository) };
}

async function stored() {
  return sqlExecutor.execute<{ identity_id: string; grants: string | null }>(
    `select c.identity_id, group_concat(s.identity_id order by s.identity_id) as grants
     from ${WS_CONNECTIONS_TABLE} c
     left join ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE} s on s.connection_id = c.connection_id
     where c.connection_id = :connectionId
     group by c.identity_id`,
    { connectionId }
  );
}

async function waitForSocketLockWaiters(
  expected: number,
  deadline = Date.now() + 5000
): Promise<void> {
  // SHOW PROCESSLIST exposes this test user's own sessions. The first owner
  // stays locked until both peer reads have actually reached the server.
  const sessions = await sqlExecutor.execute<{ Info: string | null }>(
    'show full processlist'
  );
  const waiting = sessions.filter((session) => {
    const sql = session.Info?.toLowerCase();
    return sql?.includes(connectionId) && sql.includes('for update');
  });
  if (waiting.length >= expected) return;
  if (Date.now() >= deadline)
    throw new Error('Socket lock waiters not observed');
  await delay(10);
  return waitForSocketLockWaiters(expected, deadline);
}

describeWithSeed(
  'WebSocket subscription transactions',
  [
    {
      table: WS_CONNECTIONS_TABLE,
      rows: [
        {
          connection_id: connectionId,
          identity_id: 'old',
          jwt_expiry: expiry,
          wave_id: null
        }
      ]
    },
    {
      table: WS_NOTIFICATION_SUBSCRIPTIONS_TABLE,
      rows: [
        { connection_id: connectionId, identity_id: 'old', jwt_expiry: expiry }
      ]
    }
  ],
  () => {
    it('rolls the actual identity update and deleted grants back after an insert failure', async () => {
      const { observed, sockets } = fixture();
      const failure = new Error('synthetic grant insertion failure');
      observed.beforeQuery = async (sql) => {
        if (sql.startsWith('insert into ws_notification_subscriptions'))
          throw failure;
      };
      await expect(
        sockets.authenticateConnection(
          { connectionId, identityId: 'new', jwtExpiry: expiry },
          {}
        )
      ).rejects.toBe(failure);
      expect(await stored()).toEqual([{ identity_id: 'old', grants: 'old' }]);
    });

    it('rolls a new connection back if its initial grant insertion fails', async () => {
      const { observed, repository, sockets } = fixture();
      await repository.deleteByConnectionId(connectionId, {});
      observed.beforeQuery = async (sql) => {
        if (sql.startsWith('insert into ws_notification_subscriptions'))
          throw new Error('synthetic registration failure');
      };
      await expect(
        sockets.register({
          connectionId,
          identityId: 'new',
          jwtExpiry: expiry,
          ws: {
            send: jest.fn(),
            close: jest.fn()
          } as unknown as WebSocket
        })
      ).rejects.toThrow('synthetic registration failure');
      expect(await stored()).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select connection_id from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE} where connection_id = :connectionId`,
          { connectionId }
        )
      ).toEqual([]);
    });

    it('retries a real-driver deadlock error only after rolling the whole transaction back', async () => {
      const { observed, sockets } = fixture();
      let attempts = 0;
      observed.transactionRequested = () => {
        attempts++;
      };
      let signaled = false;
      observed.beforeQuery = async (sql, options) => {
        if (
          !signaled &&
          sql.startsWith('insert into ws_notification_subscriptions')
        ) {
          signaled = true;
          // Exercises the real MySQL driver's ER_LOCK_DEADLOCK and explicit
          // rollback path; this controlled signal is not a lock-graph replay.
          await sqlExecutor.execute(
            "signal sqlstate '40001' set mysql_errno = 1213, message_text = 'synthetic deadlock'",
            {},
            options
          );
        }
      };
      await sockets.authenticateConnection(
        { connectionId, identityId: 'new', jwtExpiry: expiry },
        {}
      );
      expect(attempts).toBe(2);
      expect(await stored()).toEqual([{ identity_id: 'new', grants: 'new' }]);
    });

    it('captures the actual server session in the locking query and links a committed retry', async () => {
      const { observed, sockets } = fixture();
      const records: Record<string, unknown>[] = [];
      const sessions: number[] = [];
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((_message, detail) => {
          if (detail?.event === 'ws_transaction') records.push(detail);
        });
      const info = jest
        .spyOn(Logger.prototype, 'info')
        .mockImplementation((_message, detail) => {
          if (detail?.event === 'ws_transaction') records.push(detail);
        });
      let signaled = false;
      observed.beforeQuery = async (sql, options) => {
        if (sql.startsWith('select connection_id, connection_id()')) {
          const session = await sqlExecutor.execute<{ id: number }>(
            'select connection_id() as id',
            undefined,
            options
          );
          sessions.push(session[0].id);
        }
        if (
          !signaled &&
          sql.startsWith('insert into ws_notification_subscriptions')
        ) {
          signaled = true;
          await sqlExecutor.execute(
            "signal sqlstate '40001' set mysql_errno = 1213, message_text = 'synthetic deadlock'",
            undefined,
            options
          );
        }
      };
      try {
        await withWebSocketOperationDiagnostics(
          {
            routeKey: '$default',
            connectionId,
            lambdaRequestId: 'diagnostic-fixture'
          },
          async () => {
            setWebSocketDiagnosticOperation('AUTHENTICATE');
            await sockets.authenticateConnection(
              { connectionId, identityId: 'new', jwtExpiry: expiry },
              {}
            );
            return { statusCode: 200 };
          }
        );
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          db_session_id: sessions[0],
          isolation: 'READ-COMMITTED',
          session_isolation: 'REPEATABLE-READ',
          phase: 'insert_subscriptions',
          attempt: 1,
          outcome: 'retry_pending',
          mysql_code: 'ER_LOCK_DEADLOCK'
        });
        expect(records[1]).toMatchObject({
          db_session_id: sessions[1],
          phase: 'commit',
          attempt: 2,
          outcome: 'committed',
          recovered: true
        });
        expect(records[0].operation_id).toBe(records[1].operation_id);
        expect(records[0].mutation_id).toBe(records[1].mutation_id);
        expect(sessions).toHaveLength(2);
        expect(sessions.every((id) => Number.isSafeInteger(id) && id > 0)).toBe(
          true
        );
        expect(await stored()).toEqual([{ identity_id: 'new', grants: 'new' }]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    it.each([
      { isolation: 'REPEATABLE READ' as const, attempts: 3 },
      { isolation: undefined, attempts: 2 }
    ])(
      'replays the captured empty-grant gap cycle with isolation=$isolation',
      async ({ isolation, attempts: expectedAttempts }) => {
        // This gap-lock scenario needs an empty index, without the shared seed.
        await sqlExecutor.execute(
          `delete from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
        );
        const ids = ['zz-ws-gap-a', 'zz-ws-gap-b'];
        await sqlExecutor.execute(
          `insert into ${WS_CONNECTIONS_TABLE}
           (connection_id, identity_id, jwt_expiry)
           values (:first, 'anon', :expiry), (:second, 'anon', :expiry)`,
          { first: ids[0], second: ids[1], expiry }
        );
        const { observed, sockets } = fixture();
        observed.forcedIsolation = isolation;
        let attempts = 0;
        observed.transactionRequested = () => attempts++;
        let arrivals = 0;
        const ready = deferred();
        const release = deferred();
        observed.beforeQuery = async (sql) => {
          if (
            sql.startsWith('insert into ws_notification_subscriptions') &&
            arrivals < 2
          ) {
            arrivals++;
            if (arrivals === 2) ready.resolve();
            await release.promise;
          }
        };
        // Both sockets delete a missing grant range before either can insert.
        // Under RR they hold compatible supremum gap locks, then deadlock on
        // each other's insert intention. The repository must retry the victim.
        const completion = Promise.allSettled(
          ids.map((id) =>
            sockets.authenticateConnection(
              {
                connectionId: id,
                identityId: `identity-${id}`,
                jwtExpiry: expiry
              },
              {}
            )
          )
        );
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready.promise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error('Both grant deletes must reach the barrier')
                  ),
                5000
              );
            })
          ]);
        } finally {
          clearTimeout(timeout);
          release.resolve();
          await completion;
        }
        expect((await completion).map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled'
        ]);
        expect(attempts).toBe(expectedAttempts);
        const grants = await sqlExecutor.execute(
          `select connection_id, identity_id from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE}
           where connection_id in (:ids) order by connection_id`,
          { ids }
        );
        expect(grants).toEqual(
          ids.map((id) => ({
            connection_id: id,
            identity_id: `identity-${id}`
          }))
        );
      }
    );

    it('keeps an in-flight identity change invisible until commit, then serializes identity sync', async () => {
      const { observed, sockets } = fixture();
      const changed = deferred();
      const release = deferred();
      const syncRequested = deferred();
      observed.afterQuery = async (sql) => {
        if (sql.startsWith('update ws_connections')) {
          changed.resolve();
          await release.promise;
        }
      };
      const authentication = sockets.authenticateConnection(
        { connectionId, identityId: 'new', jwtExpiry: expiry },
        {}
      );
      await changed.promise;
      observed.transactionRequested = syncRequested.resolve;
      const sync = sockets.syncNotificationIdentities(
        connectionId,
        [
          { identityId: 'extra-b', jwtExpiry: expiry },
          { identityId: 'extra-a', jwtExpiry: expiry }
        ],
        {}
      );
      try {
        await syncRequested.promise;
        expect(await stored()).toEqual([{ identity_id: 'old', grants: 'old' }]);
      } finally {
        release.resolve();
        await Promise.all([authentication, sync]);
      }
      expect(await stored()).toEqual([
        { identity_id: 'new', grants: 'extra-a,extra-b' }
      ]);
    });

    it('concurrent authentication leaves one complete final identity and grant set', async () => {
      const { sockets } = fixture();
      await Promise.all(
        ['first', 'second', 'third'].map((identityId) =>
          sockets.authenticateConnection(
            { connectionId, identityId, jwtExpiry: expiry },
            {}
          )
        )
      );
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(['first', 'second', 'third']).toContain(rows[0].identity_id);
      expect(rows[0].grants).toBe(rows[0].identity_id);
    });

    it('reauthenticates every waiter when the locked composite key moves behind its scan', async () => {
      const { observed, sockets } = fixture();
      const locked = deferred();
      const release = deferred();
      let firstLock = true;
      let emptyLockReads = 0;
      observed.afterQuery = async (sql, rows) => {
        if (!sql.startsWith('select connection_id, connection_id()')) return;
        if (rows.length === 0) emptyLockReads++;
        if (firstLock) {
          firstLock = false;
          locked.resolve();
          await release.promise;
        }
      };
      const first = sockets.authenticateConnection(
        { connectionId, identityId: 'first', jwtExpiry: expiry },
        {}
      );
      await locked.promise;
      const completion = Promise.allSettled([
        first,
        ...['second', 'third'].map((identityId) =>
          sockets.authenticateConnection(
            { connectionId, identityId, jwtExpiry: expiry },
            {}
          )
        )
      ]);
      try {
        await waitForSocketLockWaiters(2);
      } finally {
        release.resolve();
        await completion;
      }
      expect(emptyLockReads).toBeGreaterThan(0);
      expect((await completion).map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled'
      ]);
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(['first', 'second', 'third']).toContain(rows[0].identity_id);
      expect(rows[0].grants).toBe(rows[0].identity_id);
    });

    it('a connection deletion prevents an overlapping authentication from recreating grants', async () => {
      const { observed, repository, sockets } = fixture();
      const deletedGrants = deferred();
      const release = deferred();
      const authRequested = deferred();
      observed.afterQuery = async (sql) => {
        if (sql.startsWith('delete from ws_notification_subscriptions')) {
          deletedGrants.resolve();
          await release.promise;
        }
      };
      const deletion = repository.deleteByConnectionId(connectionId, {});
      await deletedGrants.promise;
      observed.transactionRequested = authRequested.resolve;
      const authentication = sockets
        .authenticateConnection(
          { connectionId, identityId: 'new', jwtExpiry: expiry },
          {}
        )
        .then(
          () => null,
          (error: unknown) => error
        );
      try {
        await authRequested.promise;
        expect(await stored()).toEqual([{ identity_id: 'old', grants: 'old' }]);
      } finally {
        release.resolve();
        await deletion;
      }
      expect(await authentication).toEqual(
        expect.objectContaining({ message: 'Socket is not available' })
      );
      expect(await stored()).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select connection_id from ${WS_NOTIFICATION_SUBSCRIPTIONS_TABLE} where connection_id = :connectionId`,
          { connectionId }
        )
      ).toEqual([]);
    });

    it('does not commit a caller-owned transaction independently', async () => {
      const { sockets } = fixture();
      const failure = new Error('synthetic outer failure');
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sockets.authenticateConnection(
            { connectionId, identityId: 'new', jwtExpiry: expiry },
            { connection }
          );
          throw failure;
        })
      ).rejects.toBe(failure);
      expect(await stored()).toEqual([{ identity_id: 'old', grants: 'old' }]);
    });
  }
);
