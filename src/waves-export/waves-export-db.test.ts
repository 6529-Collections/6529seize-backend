const mockPoolEnd = jest.fn((done: () => void) => done());
const mockGetConnection = jest.fn((done: (error: Error) => void) =>
  done(new Error('no server'))
);
const mockCreateApiDbPool = jest.fn((..._args: unknown[]) => ({
  end: mockPoolEnd,
  getConnection: mockGetConnection
}));
jest.mock('@/db/api-sql-executor', () => ({
  ...jest.requireActual('@/db/api-sql-executor'),
  createApiDbPool: (...args: unknown[]) => mockCreateApiDbPool(...args)
}));

import { SqlExecutor, setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { withApiSqlExecutor } from './waves-export.db';

describe('withApiSqlExecutor', () => {
  const SETTINGS = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_PORT', 'DB_IAM_AUTH'];
  const saved: Record<string, string | undefined> = {};
  const before = {} as SqlExecutor;
  beforeEach(() => {
    for (const name of SETTINGS) saved[name] = process.env[name];
    process.env.DB_HOST = 'db.invalid';
    process.env.DB_USER = 'reader';
    process.env.DB_PASS = 'made-up';
    process.env.DB_PORT = '3306';
    delete process.env.DB_IAM_AUTH;
    mockCreateApiDbPool.mockClear();
    mockPoolEnd.mockClear();
    mockGetConnection.mockClear();
    setSqlExecutor(before);
  });
  afterEach(() => {
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("runs the action on the API's executor over one DB_HOST pool, then puts the old one back", async () => {
    const seen = await withApiSqlExecutor(async () => sqlExecutor);
    expect(seen).not.toBe(before);
    expect(seen.constructor.name).toBe('ApiSqlExecutor');
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(mockCreateApiDbPool).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'db.invalid', user: 'reader' }),
      3306,
      expect.any(Number)
    );
    expect(sqlExecutor).toBe(before);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('puts the old executor back and ends the pool when the action fails', async () => {
    await expect(
      withApiSqlExecutor(async () => {
        throw new Error('stage failed');
      })
    ).rejects.toThrow('stage failed');
    expect(sqlExecutor).toBe(before);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it('refuses without DB_HOST, its user or DB_PORT, before opening a pool', async () => {
    delete process.env.DB_PORT;
    const action = jest.fn();
    await expect(withApiSqlExecutor(action)).rejects.toThrow(
      'The export needs DB_HOST'
    );
    expect(action).not.toHaveBeenCalled();
    expect(mockCreateApiDbPool).not.toHaveBeenCalled();
    expect(sqlExecutor).toBe(before);
  });

  it('sends every statement, transactions included, to its one pool', async () => {
    await withApiSqlExecutor(async () => {
      await expect(sqlExecutor.execute('SELECT 1')).rejects.toThrow(
        'no server'
      );
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async () => 1)
      ).rejects.toThrow('no server');
    });
    expect(mockCreateApiDbPool).toHaveBeenCalledTimes(1);
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });
});
