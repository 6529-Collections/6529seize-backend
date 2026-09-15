import mysql from 'mysql';
import * as apiDb from '@/db-api';
import { DbQueryOptions } from '@/db-query.options';
import { getRequestScopedPromise, RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import {
  assertMembershipPrimaryContext,
  MembershipPrimaryContext,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from '@/membership/membership-primary';

class MemoryPrimaryExecutor extends SqlExecutor {
  readonly wrapped = { connection: { source: 'primary' } };
  options?: SqlTransactionOptions;
  callbackFinished = false;

  async execute<T>(
    _sql: string,
    _params?: Record<string, unknown>,
    _options?: DbQueryOptions
  ): Promise<T[]> {
    return [];
  }

  async executeNativeQueriesInTransaction<T>(
    callback: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    this.options = options;
    try {
      return await callback(this.wrapped);
    } finally {
      this.callbackFinished = true;
    }
  }
}

describe('membership primary context lifecycle', () => {
  it('mints a bound, immutable context only for the callback lifetime', async () => {
    const db = new MemoryPrimaryExecutor();
    let captured: MembershipPrimaryContext | undefined;
    await expect(
      withMembershipPrimaryTransaction(db, async (ctx) => {
        captured = ctx;
        expect(() => assertMembershipPrimaryContext(ctx)).not.toThrow();
        expect(ctx.connection.connection).toBe(db.wrapped.connection);
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.connection)).toBe(true);
        expect(() => assertMembershipPrimaryContext({ ...ctx })).toThrow(
          'active primary'
        );
        return 'done';
      })
    ).resolves.toBe('done');
    expect(db.options).toEqual({ isolationLevel: 'REPEATABLE READ' });
    expect(() => assertMembershipPrimaryContext(captured!)).toThrow(
      'active primary'
    );
    expect(() => membershipQueryOptions(captured!)).toThrow('active primary');
  });

  it('revokes the context on callback failure and rejects forged connections', async () => {
    const db = new MemoryPrimaryExecutor();
    let captured: MembershipPrimaryContext | undefined;
    await expect(
      withMembershipPrimaryTransaction(db, async (ctx) => {
        captured = ctx;
        throw new Error('callback failed');
      })
    ).rejects.toThrow('callback failed');
    expect(() => assertMembershipPrimaryContext(captured!)).toThrow(
      'active primary'
    );
    expect(() =>
      assertMembershipPrimaryContext({ connection: db.wrapped })
    ).toThrow('active primary');
    expect(() =>
      assertMembershipPrimaryContext(null as unknown as RequestContext)
    ).toThrow('active primary');
  });

  it('refuses nesting in caller transactions before opening another connection', async () => {
    const db = new MemoryPrimaryExecutor();
    await expect(
      withMembershipPrimaryTransaction(db, async () => 'no', {
        connection: db.wrapped
      })
    ).rejects.toThrow('cannot nest');
    expect(db.options).toBeUndefined();
    await withMembershipPrimaryTransaction(db, async (ctx) => {
      await expect(
        withMembershipPrimaryTransaction(db, async () => 'no', ctx)
      ).rejects.toThrow('cannot nest');
    });
  });

  it('preserves request metadata while replacing even enumerable stale cache state', async () => {
    const db = new MemoryPrimaryExecutor();
    const caller: RequestContext = {
      moderationRequestId: 'request-1',
      moderationPermitGeneration: 3,
      requestScope: {
        promisesByKey: new Map([['identity', Promise.resolve('stale')]])
      }
    };
    const load = jest.fn().mockResolvedValue('primary');
    await withMembershipPrimaryTransaction(
      db,
      async (ctx) => {
        expect(ctx.moderationRequestId).toBe('request-1');
        expect(ctx.moderationPermitGeneration).toBe(3);
        expect(ctx.requestScope).not.toBe(caller.requestScope);
        expect(await getRequestScopedPromise(ctx, 'identity', load)).toBe(
          'primary'
        );
        expect(await getRequestScopedPromise(ctx, 'identity', load)).toBe(
          'primary'
        );
      },
      caller
    );
    await withMembershipPrimaryTransaction(
      db,
      async (ctx) => {
        expect(await getRequestScopedPromise(ctx, 'identity', load)).toBe(
          'primary'
        );
      },
      caller
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(await caller.requestScope!.promisesByKey.get('identity')).toBe(
      'stale'
    );
  });
});

interface RoutingConnection {
  readonly connection: mysql.PoolConnection;
  readonly statements: string[];
  readonly begin: jest.Mock;
  readonly commit: jest.Mock;
  readonly rollback: jest.Mock;
  readonly release: jest.Mock;
}

function routingConnection(
  source: string,
  beginError?: Error
): RoutingConnection {
  const statements: string[] = [];
  const begin = jest.fn((callback?: (error?: Error) => void) => {
    statements.push('BEGIN');
    setImmediate(() => callback?.(beginError));
  });
  const commit = jest.fn((callback: (error?: Error) => void) => {
    statements.push('COMMIT');
    callback();
  });
  const rollback = jest.fn((callback?: () => void) => {
    statements.push('ROLLBACK');
    callback?.();
  });
  const release = jest.fn();
  const connection = {
    config: {},
    beginTransaction: begin,
    commit,
    rollback,
    release,
    query: (
      query: string | { sql: string },
      callback: (error: null, result: unknown[]) => void
    ) => {
      const sql = typeof query === 'string' ? query : query.sql;
      statements.push(sql);
      callback(null, [{ source }]);
    }
  } as unknown as mysql.PoolConnection;
  return { connection, statements, begin, commit, rollback, release };
}

describe('membership queries through the real API SqlExecutor adapter', () => {
  let previousExecutor: SqlExecutor;

  beforeEach(() => {
    previousExecutor = sqlExecutor;
  });
  afterEach(async () => {
    await apiDb.disconnect();
    setSqlExecutor(previousExecutor);
    jest.restoreAllMocks();
  });

  async function connectRoutingPools(beginError?: Error) {
    const write = routingConnection('primary', beginError);
    const read = routingConnection('stale-replica');
    const pools = [write, read].map(({ connection }) => ({
      getConnection: jest.fn(
        (callback: (error: null, connection: mysql.PoolConnection) => void) =>
          callback(null, connection)
      ),
      end: (callback: (error?: Error) => void) => callback()
    }));
    jest
      .spyOn(mysql, 'createPool')
      .mockReturnValueOnce(pools[0] as unknown as mysql.Pool)
      .mockReturnValueOnce(pools[1] as unknown as mysql.Pool);
    await apiDb.connect();
    return { write, read, pools };
  }

  it('routes ordinary SELECT to replica and membership SELECT to its one primary transaction', async () => {
    const { write, read, pools } = await connectRoutingPools();
    expect(await sqlExecutor.execute('SELECT source')).toEqual([
      { source: 'stale-replica' }
    ]);
    await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
      expect(
        await sqlExecutor.execute(
          'SELECT source',
          undefined,
          membershipQueryOptions(ctx)
        )
      ).toEqual([{ source: 'primary' }]);
      expect(
        await sqlExecutor.execute(
          'SELECT source FOR UPDATE',
          undefined,
          membershipQueryOptions(ctx)
        )
      ).toEqual([{ source: 'primary' }]);
      expect(write.release).not.toHaveBeenCalled();
    });
    expect(write.statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'BEGIN',
      'SELECT source',
      'SELECT source FOR UPDATE',
      'COMMIT'
    ]);
    expect(read.statements).toEqual(['SELECT source']);
    expect(pools[0].getConnection).toHaveBeenCalledTimes(1);
    expect(pools[1].getConnection).toHaveBeenCalledTimes(1);
    expect(write.release).toHaveBeenCalledTimes(1);
  });

  it('never runs membership work after asynchronous BEGIN failure', async () => {
    const { write } = await connectRoutingPools(new Error('begin failed'));
    const callback = jest.fn().mockResolvedValue('unexpected');
    await expect(
      withMembershipPrimaryTransaction(sqlExecutor, callback)
    ).rejects.toThrow('begin failed');
    expect(callback).not.toHaveBeenCalled();
    expect(write.commit).not.toHaveBeenCalled();
    expect(write.rollback).toHaveBeenCalledTimes(1);
    expect(write.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back failed membership work before releasing its primary connection', async () => {
    const { write } = await connectRoutingPools();
    await expect(
      withMembershipPrimaryTransaction(sqlExecutor, async () => {
        throw new Error('work failed');
      })
    ).rejects.toThrow('work failed');
    expect(write.statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'BEGIN',
      'ROLLBACK'
    ]);
    expect(write.release).toHaveBeenCalledTimes(1);
  });
});
