const mockPoolEnd = jest.fn((done: () => void) => done());
const mockGetConnection = jest.fn((done: (error: Error) => void) =>
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
const mockInstallIam = jest.fn();
jest.mock('@/db-iam-auth', () => ({
  ...jest.requireActual('@/db-iam-auth'),
  installMysqlIamAuthSupport: () => mockInstallIam()
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
      mockPoolOn,
      mockInstallIam
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
    expect(mockInstallIam).not.toHaveBeenCalled();
    expect(executor.sqlExecutor).toBe(before);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('makes each new connection read-only before anything else runs on it', async () => {
    const { db } = load();
    await db.withApiSqlExecutor(async () => undefined);
    expect(mockPoolOn).toHaveBeenCalledWith('connection', expect.any(Function));
    const onConnection = mockPoolOn.mock.calls[0][1];
    const connection = { query: jest.fn(), destroy: jest.fn() };
    onConnection(connection);
    expect(connection.query).toHaveBeenCalledWith(
      'SET SESSION TRANSACTION READ ONLY',
      expect.any(Function)
    );
    // A connection that can't be made read-only is destroyed: fail closed.
    connection.query.mock.calls[0][1](null);
    expect(connection.destroy).not.toHaveBeenCalled();
    connection.query.mock.calls[0][1](new Error('refused'));
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
    expect(mockInstallIam).toHaveBeenCalledTimes(1);
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
    expect(mockInstallIam).not.toHaveBeenCalled();
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
