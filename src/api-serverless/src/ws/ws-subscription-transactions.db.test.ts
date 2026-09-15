import type WebSocket from 'ws';
import {
  WS_CONNECTIONS_TABLE,
  WS_NOTIFICATION_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { ConnectionWrapper, SqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { AppWebSockets } from './ws';
import { WsConnectionRepository } from './ws-connection.repository';

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
  afterQuery?: (sql: string) => Promise<void>;
  transactionRequested?: () => void;
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
    await this.afterQuery?.(normalized);
    return result;
  }

  executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    this.transactionRequested?.();
    return this.delegate.executeNativeQueriesInTransaction(executable);
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
