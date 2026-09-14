import type { PoolConnection } from 'mysql';
import { DbQueryOptions } from '@/db-query.options';
import { execNativeTransactionally } from '@/db/my-sql.helpers';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import { AppWebSockets } from './ws';
import { WsConnectionRepository } from './ws-connection.repository';
import { setTimeout as delay } from 'node:timers/promises';

jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn(async () => {})
}));

type Identity = { identityId: string; jwtExpiry: number };
type State = { identity: Identity | null; subscriptions: Identity[] };
type Transaction = { state: State };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Models transactional visibility around the real repository and SQL transaction helper.
 * It does not claim to reproduce MySQL's lock scheduler or the historical deadlock graph. */
class SubscriptionDatabase extends SqlExecutor {
  state: State = {
    identity: { identityId: 'old', jwtExpiry: 100 },
    subscriptions: [{ identityId: 'old', jwtExpiry: 100 }]
  };
  operations: { sql: string; transactional: boolean }[] = [];
  attempts = 0;
  commits = 0;
  rollbacks = 0;
  releases = 0;
  commitFailure: Error | undefined;
  fail: ((sql: string) => Error | null) | undefined;
  afterWrite: (() => Promise<void>) | undefined;
  onTransactionRequested: (() => void) | undefined;
  private queue = Promise.resolve();

  async execute<T>(
    sql: string,
    params: Record<string, unknown> = {},
    options?: DbQueryOptions
  ): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const transaction = options?.wrappedConnection?.connection as
      | Transaction
      | undefined;
    this.operations.push({ sql: normalized, transactional: !!transaction });
    const state = transaction?.state ?? this.state;
    const error = this.fail?.(normalized);
    if (error) throw error;
    if (normalized.startsWith('select connection_id from ws_connections')) {
      return (state.identity ? [{ connection_id: 'socket' }] : []) as T[];
    }
    if (normalized.startsWith('update ws_connections')) {
      if (state.identity)
        state.identity = {
          identityId: String(params.identityId),
          jwtExpiry: Number(params.jwtExpiry)
        };
    } else if (normalized.startsWith('insert into ws_connections')) {
      state.identity = {
        identityId: String(params.identity_id),
        jwtExpiry: Number(params.jwt_expiry)
      };
    } else if (normalized.startsWith('delete from ws_connections')) {
      state.identity = null;
    } else if (
      normalized.startsWith('delete from ws_notification_subscriptions')
    ) {
      state.subscriptions = [];
    } else if (
      normalized.startsWith('insert into ws_notification_subscriptions')
    ) {
      state.subscriptions = Object.keys(params)
        .filter((key) => key.startsWith('identityId'))
        .map((key) => ({
          identityId: String(params[key]),
          jwtExpiry: Number(
            params['jwtExpiry' + key.slice('identityId'.length)]
          )
        }));
    } else {
      throw new Error('Unexpected fixture SQL');
    }
    await this.afterWrite?.();
    return [];
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    this.onTransactionRequested?.();
    const previous = this.queue;
    const finished = deferred();
    this.queue = finished.promise;
    await previous;
    this.attempts++;
    const transaction: Transaction = { state: structuredClone(this.state) };
    const connection = Object.assign(transaction, {
      beginTransaction: jest.fn(),
      commit: (callback: (error?: Error) => void) => {
        // An ambiguous connection failure may arrive after the server committed.
        this.state = transaction.state;
        this.commits++;
        callback(this.commitFailure);
      },
      rollback: () => {
        this.rollbacks++;
      },
      release: () => {
        this.releases++;
      }
    });
    try {
      return await execNativeTransactionally(
        executable,
        connection as unknown as PoolConnection
      );
    } finally {
      finished.resolve();
    }
  }
}

function fixture() {
  const db = new SubscriptionDatabase();
  const repository = new WsConnectionRepository(
    () => db,
    {} as never,
    () => false
  );
  const sockets = new AppWebSockets(repository);
  return { db, repository, sockets };
}

describe('WebSocket identity and notification subscription atomicity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('rolls identity and old notification grants back together if replacement fails', async () => {
    const { db, sockets } = fixture();
    const original = structuredClone(db.state);
    const failure = Object.assign(new Error('synthetic write failure'), {
      code: 'ER_RECORD_FILE_FULL'
    });
    db.fail = (sql) =>
      sql.startsWith('insert into ws_notification_subscriptions')
        ? failure
        : null;
    await expect(
      sockets.authenticateConnection(
        { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
        {}
      )
    ).rejects.toBe(failure);
    expect(db.state).toEqual(original);
    expect(db.commits).toBe(0);
    expect(db.rollbacks).toBe(1);
  });

  it('does not leave a registered identity without its initial grants on failure', async () => {
    const { db, sockets } = fixture();
    db.state = { identity: null, subscriptions: [] };
    const failure = new Error('synthetic initial grant failure');
    db.fail = (sql) =>
      sql.startsWith('insert into ws_notification_subscriptions')
        ? failure
        : null;
    await expect(
      sockets.register({
        connectionId: 'socket',
        identityId: 'new',
        jwtExpiry: 200
      })
    ).rejects.toBe(failure);
    expect(db.state).toEqual({ identity: null, subscriptions: [] });
  });

  it('keeps concurrent reauth operations from mixing one identity with another grant set', async () => {
    const { db, sockets } = fixture();
    const firstWrite = deferred();
    const releaseFirst = deferred();
    const secondTransaction = deferred();
    let writes = 0;
    db.afterWrite = async () => {
      if (++writes === 1) {
        firstWrite.resolve();
        await releaseFirst.promise;
      }
    };
    const first = sockets.authenticateConnection(
      { connectionId: 'socket', identityId: 'first', jwtExpiry: 200 },
      {}
    );
    await firstWrite.promise;
    db.onTransactionRequested = secondTransaction.resolve;
    const second = sockets.authenticateConnection(
      { connectionId: 'socket', identityId: 'second', jwtExpiry: 300 },
      {}
    );
    await secondTransaction.promise;
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(db.state.subscriptions).toEqual([db.state.identity]);
    expect(db.operations.every(({ transactional }) => transactional)).toBe(
      true
    );
  });

  it.each(['delete from', 'insert into'])(
    'replays the whole transaction after one %s deadlock',
    async (verb) => {
      const { db, sockets } = fixture();
      const failure = Object.assign(new Error('synthetic deadlock'), {
        code: 'ER_LOCK_DEADLOCK'
      });
      let failures = 0;
      db.fail = (sql) =>
        sql.startsWith(verb + ' ws_notification_subscriptions') &&
        failures++ === 0
          ? failure
          : null;
      await sockets.authenticateConnection(
        { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
        {}
      );
      expect(db.state).toEqual({
        identity: { identityId: 'new', jwtExpiry: 200 },
        subscriptions: [{ identityId: 'new', jwtExpiry: 200 }]
      });
      expect(db.attempts).toBe(2);
      expect(db.rollbacks).toBe(1);
      expect(db.commits).toBe(1);
      expect(db.releases).toBe(2);
      expect(
        db.operations.filter(({ sql }) =>
          sql.startsWith('update ws_connections')
        )
      ).toHaveLength(2);
      expect(delay).toHaveBeenCalledTimes(1);
      const wait = jest.mocked(delay).mock.calls[0][0]!;
      expect(wait).toBeGreaterThanOrEqual(10);
      expect(wait).toBeLessThanOrEqual(25);
    }
  );

  it('stops after three confirmed deadlocks, retaining old state and the final error', async () => {
    const { db, sockets } = fixture();
    const original = structuredClone(db.state);
    const failures = Array.from({ length: 3 }, (_, index) =>
      Object.assign(new Error('synthetic deadlock ' + index), {
        code: 'ER_LOCK_DEADLOCK'
      })
    );
    let failureIndex = 0;
    db.fail = (sql) =>
      sql.startsWith('insert into ws_notification_subscriptions')
        ? failures[failureIndex++]
        : null;
    await expect(
      sockets.authenticateConnection(
        { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
        {}
      )
    ).rejects.toBe(failures[2]);
    expect(db.state).toEqual(original);
    expect(db.attempts).toBe(3);
    expect(db.rollbacks).toBe(3);
    expect(db.commits).toBe(0);
    expect(delay).toHaveBeenCalledTimes(2);
    const secondWait = jest.mocked(delay).mock.calls[1][0]!;
    expect(secondWait).toBeGreaterThanOrEqual(20);
    expect(secondWait).toBeLessThanOrEqual(50);
  });

  it.each([
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_DUP_ENTRY',
    'ER_RECORD_FILE_FULL',
    'PROTOCOL_CONNECTION_LOST',
    undefined
  ])('does not retry non-deadlock failure %s', async (code) => {
    const { db, sockets } = fixture();
    const original = structuredClone(db.state);
    const failure = Object.assign(new Error('synthetic database failure'), {
      code
    });
    db.fail = (sql) =>
      sql.startsWith('delete from ws_notification_subscriptions')
        ? failure
        : null;
    await expect(
      sockets.syncNotificationIdentities('socket', [], {})
    ).rejects.toBe(failure);
    expect(db.state).toEqual(original);
    expect(db.attempts).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not replay an ambiguous commit response', async () => {
    const { db, sockets } = fixture();
    db.commitFailure = Object.assign(
      new Error('synthetic commit transport failure'),
      { code: 'PROTOCOL_CONNECTION_LOST' }
    );
    await expect(
      sockets.authenticateConnection(
        { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
        {}
      )
    ).rejects.toBe(db.commitFailure);
    expect(db.attempts).toBe(1);
    expect(db.commits).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('leaves deadlock replay and rollback to the owner of an existing transaction', async () => {
    const { db, sockets } = fixture();
    const original = structuredClone(db.state);
    const failure = Object.assign(new Error('synthetic outer deadlock'), {
      code: 'ER_LOCK_DEADLOCK'
    });
    db.fail = (sql) =>
      sql.startsWith('insert into ws_notification_subscriptions')
        ? failure
        : null;
    await expect(
      db.executeNativeQueriesInTransaction((connection) =>
        sockets.authenticateConnection(
          { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
          { connection }
        )
      )
    ).rejects.toBe(failure);
    expect(db.state).toEqual(original);
    expect(db.attempts).toBe(1);
    expect(db.rollbacks).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it.each(['auth', 'sync'])(
    'rejects %s for a missing connection without creating grants',
    async (operation) => {
      const { db, sockets } = fixture();
      db.state = { identity: null, subscriptions: [] };
      const action =
        operation === 'auth'
          ? sockets.authenticateConnection(
              { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
              {}
            )
          : sockets.syncNotificationIdentities(
              'socket',
              [{ identityId: 'new', jwtExpiry: 200 }],
              {}
            );
      await expect(action).rejects.toThrow('Socket is not available');
      expect(db.state).toEqual({ identity: null, subscriptions: [] });
      expect(db.operations).toHaveLength(1);
      expect(db.operations[0].sql).toContain('order by identity_id for update');
      expect(db.commits).toBe(0);
    }
  );

  it('removes connection and grants atomically, and can clean an orphan idempotently', async () => {
    const { db, repository } = fixture();
    const original = structuredClone(db.state);
    const failure = new Error('synthetic deletion failure');
    db.fail = (sql) =>
      sql.startsWith('delete from ws_connections') ? failure : null;
    await expect(repository.deleteByConnectionId('socket', {})).rejects.toBe(
      failure
    );
    expect(db.state).toEqual(original);
    db.fail = undefined;
    db.state.identity = null;
    await repository.deleteByConnectionId('socket', {});
    await repository.deleteByConnectionId('socket', {});
    expect(db.state).toEqual({ identity: null, subscriptions: [] });
    expect(db.operations[0].sql).toContain('for update');
  });

  it('a deletion racing reauthentication leaves no identity or grants after deletion commits', async () => {
    const { db, sockets, repository } = fixture();
    const firstWrite = deferred();
    const releaseFirst = deferred();
    const deleteRequested = deferred();
    let writes = 0;
    db.afterWrite = async () => {
      if (++writes === 1) {
        firstWrite.resolve();
        await releaseFirst.promise;
      }
    };
    const auth = sockets.authenticateConnection(
      { connectionId: 'socket', identityId: 'new', jwtExpiry: 200 },
      {}
    );
    await firstWrite.promise;
    db.onTransactionRequested = deleteRequested.resolve;
    const deletion = repository.deleteByConnectionId('socket', {});
    await deleteRequested.promise;
    releaseFirst.resolve();
    await Promise.all([auth, deletion]);
    expect(db.state).toEqual({ identity: null, subscriptions: [] });
    await expect(
      sockets.syncNotificationIdentities(
        'socket',
        [{ identityId: 'new', jwtExpiry: 200 }],
        {}
      )
    ).rejects.toThrow('Socket is not available');
    expect(db.state).toEqual({ identity: null, subscriptions: [] });
  });

  it('sorts only stored grants, preserving the authenticated response order and newest expiry', async () => {
    const { db, sockets } = fixture();
    const supplied = [
      { identityId: 'z', jwtExpiry: 200 },
      { identityId: 'a', jwtExpiry: 300 },
      { identityId: 'z', jwtExpiry: 400 }
    ];
    const before = structuredClone(supplied);
    await expect(
      sockets.syncNotificationIdentities('socket', supplied, {})
    ).resolves.toEqual(['z', 'a']);
    expect(db.state.subscriptions).toEqual([
      { identityId: 'a', jwtExpiry: 300 },
      { identityId: 'z', jwtExpiry: 400 }
    ]);
    expect(supplied).toEqual(before);
    expect(db.operations[0].sql).toContain('for update');
  });
});
