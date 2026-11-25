const mockPoolEnd = jest.fn((done: () => void) => done());
const mockGetConnection = jest.fn(
  (done: (error: Error | null, c?: object) => void) =>
    done(new Error('no server'))
);
const mockPoolOn = jest.fn();
const mockCreateApiDbPool = jest.fn((..._args: unknown[]) => ({
  end: mockPoolEnd,
  getConnection: mockGetConnection,
  on: mockPoolOn
}));
jest.mock('@/db/api-sql-executor', () => ({
  ...jest.requireActual('@/db/api-sql-executor'),
  createApiDbPool: (...args: unknown[]) => mockCreateApiDbPool(...args)
}));
import type { SqlExecutor } from '@/sql-executor';

/**
 * withApiSqlExecutor runs once per process, so each test loads a fresh copy
 * of it, with its own sql-executor module.
 */
function load() {
  let loaded!: {
    executor: typeof import('@/sql-executor');
    db: typeof import('./waves-export.db');
  };
  jest.isolateModules(() => {
    loaded = {
      executor: require('@/sql-executor'),
      db: require('./waves-export.db')
    };
  });
  return loaded;
}

describe('withApiSqlExecutor', () => {
  const SETTINGS = [
    'DB_HOST',
    'DB_USER',
    'DB_PASS',
    'DB_PORT',
    'DB_IAM_AUTH',
    'DB_IAM_HOST',
    'DB_IAM_USER',
    'DB_IAM_HOST_READ',
    'DB_IAM_USER_READ'
  ];
  const saved: Record<string, string | undefined> = {};
  const before = {} as SqlExecutor;
  beforeEach(() => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.DB_HOST = 'db.invalid';
    process.env.DB_USER = 'reader';
    process.env.DB_PASS = 'made-up';
    process.env.DB_PORT = '3306';
    for (const mock of [
      mockCreateApiDbPool,
      mockPoolEnd,
      mockGetConnection,
      mockPoolOn
    ]) {
      mock.mockClear();
    }
  });
  afterEach(() => {
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("runs the action on the API's executor over one DB_HOST pool, then puts the old one back", async () => {
    const { executor, db } = load();
    executor.setSqlExecutor(before);
    const seen = await db.withApiSqlExecutor(async () => executor.sqlExecutor);
    expect(seen).not.toBe(before);
    expect(seen.constructor.name).toBe('ApiSqlExecutor');
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(mockCreateApiDbPool).toHaveBeenCalledWith(
      { host: 'db.invalid', user: 'reader', password: 'made-up', iam: false },
      3306,
      expect.any(Number)
    );
    expect(executor.sqlExecutor).toBe(before);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * A pool that hands out a new `connection` as mysql2's does: 'connection'
   * first (the hook), then the caller's callback.
   */
  function handsOut(connection: object) {
    mockGetConnection.mockImplementationOnce(
      (done: (error: Error | null, c?: object) => void) => {
        const [, onConnection] = mockPoolOn.mock.calls.find(
          ([event]) => event === 'connection'
        )!;
        onConnection(connection);
        done(null, connection);
      }
    );
  }

  it('runs no statement on a connection until its read-only SET has succeeded', async () => {
    const { executor, db } = load();
    let finishSet: (error: Error | null) => void = () => undefined;
    const connection = {
      query: jest.fn((sql: string, ...rest: unknown[]) => {
        const done = rest[rest.length - 1] as (
          error: Error | null,
          rows?: unknown
        ) => void;
        if (sql === 'SET SESSION TRANSACTION READ ONLY') finishSet = done;
        else done(null, [{ n: 1 }]);
      }),
      release: jest.fn(),
      config: {},
      destroy: jest.fn()
    };
    handsOut(connection);
    await db.withApiSqlExecutor(async () => {
      const read = executor.sqlExecutor.execute('SELECT 1 AS n');
      await new Promise((resolve) => setImmediate(resolve));
      // Only the SET so far: the read waits for it.
      expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
        'SET SESSION TRANSACTION READ ONLY'
      ]);
      finishSet(null);
      await expect(read).resolves.toEqual([{ n: 1 }]);
    });
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('refuses the statement and destroys a connection whose SET failed: fail closed, no wait', async () => {
    const { executor, db } = load();
    const connection = {
      query: jest.fn((sql: string, ...rest: unknown[]) => {
        const done = rest[rest.length - 1] as (error: Error | null) => void;
        done(
          sql === 'SET SESSION TRANSACTION READ ONLY'
            ? Object.assign(new Error('refused'), { code: 'ER_PARSE_ERROR' })
            : null
        );
      }),
      release: jest.fn(),
      config: {},
      destroy: jest.fn()
    };
    handsOut(connection);
    await db.withApiSqlExecutor(async () => {
      await expect(executor.sqlExecutor.execute('SELECT 1')).rejects.toThrow(
        'An export connection could not be made read-only: ER_PARSE_ERROR'
      );
    });
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SET SESSION TRANSACTION READ ONLY'
    ]);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it('puts the old executor back and ends the pool when the action fails', async () => {
    const { executor, db } = load();
    executor.setSqlExecutor(before);
    await expect(
      db.withApiSqlExecutor(async () => {
        throw new Error('stage failed');
      })
    ).rejects.toThrow('stage failed');
    expect(executor.sqlExecutor).toBe(before);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('refuses a second call in one process: DB services keep the executor they first read', async () => {
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined);
    const action = jest.fn();
    await expect(db.withApiSqlExecutor(action)).rejects.toThrow(
      'once per process'
    );
    expect(action).not.toHaveBeenCalled();
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
  });

  it("keeps the scope for a caller's next run in the process, on the same server", async () => {
    const { executor, db } = load();
    executor.setSqlExecutor(before);
    const first = await db.withApiSqlExecutor(
      async () => executor.sqlExecutor,
      { keepOpen: true }
    );
    expect(executor.sqlExecutor).toBe(before);
    expect(mockPoolEnd).not.toHaveBeenCalled();
    // The job's next stage: the same executor and pool, which the DB
    // services keep.
    const second = await db.withApiSqlExecutor(
      async () => executor.sqlExecutor,
      { keepOpen: true }
    );
    expect(second).toBe(first);
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    // A run that doesn't keep it ends it, and the process's one scope is
    // used up.
    const third = await db.withApiSqlExecutor(async () => executor.sqlExecutor);
    expect(third).toBe(first);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    await expect(db.withApiSqlExecutor(async () => undefined)).rejects.toThrow(
      'once per process'
    );
    expect(executor.sqlExecutor).toBe(before);
  });

  it("makes a kept scope's new connections read-only too, in a later run", async () => {
    const { executor, db } = load();
    await db.withApiSqlExecutor(async () => undefined, { keepOpen: true });
    // The job's next stage: a new connection of the kept pool waits for its
    // SET, and one whose SET fails refuses its statement.
    let finishSet: (error: Error | null) => void = () => undefined;
    const fresh = {
      query: jest.fn((sql: string, ...rest: unknown[]) => {
        const done = rest[rest.length - 1] as (
          error: Error | null,
          rows?: unknown
        ) => void;
        if (sql === 'SET SESSION TRANSACTION READ ONLY') finishSet = done;
        else done(null, [{ n: 1 }]);
      }),
      release: jest.fn(),
      config: {},
      destroy: jest.fn()
    };
    handsOut(fresh);
    const refused = {
      query: jest.fn((sql: string, ...rest: unknown[]) => {
        const done = rest[rest.length - 1] as (error: Error | null) => void;
        done(
          sql === 'SET SESSION TRANSACTION READ ONLY'
            ? Object.assign(new Error('refused'), { code: 'ER_PARSE_ERROR' })
            : null
        );
      }),
      release: jest.fn(),
      config: {},
      destroy: jest.fn()
    };
    handsOut(refused);
    await db.withApiSqlExecutor(
      async () => {
        const read = executor.sqlExecutor.execute('SELECT 1 AS n');
        await new Promise((resolve) => setImmediate(resolve));
        expect(fresh.query.mock.calls.map(([sql]) => sql)).toEqual([
          'SET SESSION TRANSACTION READ ONLY'
        ]);
        finishSet(null);
        await expect(read).resolves.toEqual([{ n: 1 }]);
        await expect(executor.sqlExecutor.execute('SELECT 1')).rejects.toThrow(
          'An export connection could not be made read-only: ER_PARSE_ERROR'
        );
      },
      { keepOpen: true }
    );
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(fresh.destroy).not.toHaveBeenCalled();
    expect(refused.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a kept scope on another server', async () => {
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined, { keepOpen: true });
    process.env.DB_HOST = 'other.invalid';
    const action = jest.fn();
    await expect(
      db.withApiSqlExecutor(action, { keepOpen: true })
    ).rejects.toThrow("The export's DB scope is open on another server");
    expect(action).not.toHaveBeenCalled();
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['longer', 'made-up-rotated'],
    ['the same length', 'made-uq'],
    ['shorter', 'made']
  ])(
    'refuses a kept scope after the password changes (%s): a new process opens the new login',
    async (_, rotated) => {
      const { db } = load();
      const createHash = jest.spyOn(
        jest.requireActual('node:crypto'),
        'createHash'
      );
      await db.withApiSqlExecutor(async () => undefined, { keepOpen: true });
      process.env.DB_PASS = rotated;
      const action = jest.fn();
      const refusal = db.withApiSqlExecutor(action, { keepOpen: true });
      await expect(refusal).rejects.toThrow(
        'a new server or password needs a new process'
      );
      // The refusal names neither password, nor the server it was open on.
      const message = await refusal.catch((error: Error) => error.message);
      for (const secret of ['made-up', rotated, 'db.invalid', 'reader']) {
        expect(message).not.toContain(secret);
      }
      expect(action).not.toHaveBeenCalled();
      expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
      // No password is hashed: it is only compared.
      expect(createHash).not.toHaveBeenCalled();
      createHash.mockRestore();
      // The same password again: the kept scope runs.
      process.env.DB_PASS = 'made-up';
      await db.withApiSqlExecutor(action);
      expect(action).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps an IAM scope across runs: no password in its identity', async () => {
    process.env.DB_IAM_AUTH = 'true';
    process.env.DB_IAM_HOST = 'proxy.invalid';
    process.env.DB_IAM_USER = 'iam-reader';
    process.env.DB_IAM_HOST_READ = 'proxy-read.invalid';
    process.env.DB_IAM_USER_READ = 'iam-reader';
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined, { keepOpen: true });
    // DB_PASS isn't read in IAM mode: a change to it is no other login.
    process.env.DB_PASS = 'made-up-rotated';
    await db.withApiSqlExecutor(async () => undefined);
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it.each(['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_PORT'])(
    'refuses without %s, before opening a pool',
    async (setting) => {
      delete process.env[setting];
      const { executor, db } = load();
      executor.setSqlExecutor(before);
      const action = jest.fn();
      await expect(db.withApiSqlExecutor(action)).rejects.toThrow(
        'The export needs DB_HOST, DB_USER, DB_PASS and DB_PORT'
      );
      expect(action).not.toHaveBeenCalled();
      expect(mockCreateApiDbPool).not.toHaveBeenCalled();
      expect(executor.sqlExecutor).toBe(before);
      // A refused call doesn't use up the process's one scope.
      process.env[setting] = setting === 'DB_PORT' ? '3306' : 'made-up';
      await db.withApiSqlExecutor(async () => undefined);
      expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    }
  );

  it('reads through DB_IAM_HOST in IAM mode, with all four IAM settings', async () => {
    process.env.DB_IAM_AUTH = 'true';
    process.env.DB_IAM_HOST = 'proxy.invalid';
    process.env.DB_IAM_USER = 'iam-reader';
    process.env.DB_IAM_HOST_READ = 'proxy-read.invalid';
    process.env.DB_IAM_USER_READ = 'iam-reader';
    delete process.env.DB_PASS;
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined);
    // The IAM target goes to createApiDbPool, whose pool logs in with the
    // token through its login plugin.
    expect(mockCreateApiDbPool).toHaveBeenCalledWith(
      { host: 'proxy.invalid', user: 'iam-reader', iam: true },
      3306,
      expect.any(Number)
    );
  });

  it('falls back to DB_HOST with its password when the IAM settings are incomplete', async () => {
    process.env.DB_IAM_AUTH = 'true';
    process.env.DB_IAM_HOST = 'proxy.invalid';
    process.env.DB_IAM_USER = 'iam-reader';
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined);
    expect(mockCreateApiDbPool).toHaveBeenCalledWith(
      { host: 'db.invalid', user: 'reader', password: 'made-up', iam: false },
      3306,
      expect.any(Number)
    );
  });

  it('sends every statement, transactions included, to its one pool', async () => {
    const { executor, db } = load();
    await db.withApiSqlExecutor(async () => {
      await expect(executor.sqlExecutor.execute('SELECT 1')).rejects.toThrow(
        'no server'
      );
      await expect(
        executor.sqlExecutor.executeNativeQueriesInTransaction(async () => 1)
      ).rejects.toThrow('no server');
    });
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });
});
