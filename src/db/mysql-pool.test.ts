import { performance } from 'node:perf_hooks';
import * as mysql from 'mysql2';
import { DataSource } from 'typeorm';
import type { MysqlDriver } from 'typeorm/driver/mysql/MysqlDriver';
import { mysql2TypeOrmOptions } from './mysql-driver-compat';
import { createMysqlPool } from './mysql-pool';
import {
  FakeMysqlServer,
  FakeMysqlServerOptions,
  FakeReply,
  FIELD_TYPE
} from '@/tests/fake-mysql-server';

let server: FakeMysqlServer | undefined;
let pool: mysql.Pool | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) =>
    pool ? pool.end(() => resolve()) : resolve()
  );
  await server?.stop();
  pool = undefined;
  server = undefined;
});

async function startServer(options: FakeMysqlServerOptions): Promise<number> {
  server = new FakeMysqlServer(options);
  return server.start();
}

async function start(
  options: FakeMysqlServerOptions,
  acquireTimeoutMs = 1_000,
  poolOptions: mysql.PoolOptions = {}
): Promise<mysql.Pool> {
  const port = await startServer(options);
  pool = createMysqlPool(
    {
      host: '127.0.0.1',
      port,
      user: 'u',
      password: 'p',
      connectionLimit: 2,
      ...poolOptions
    },
    { acquireTimeoutMs }
  );
  return pool;
}

function acquire(target: mysql.Pool): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) =>
    target.getConnection((error, connection) =>
      error ? reject(error) : resolve(connection)
    )
  );
}

function select(connection: mysql.PoolConnection): Promise<unknown> {
  return new Promise((resolve, reject) =>
    connection.query('SELECT 1', (error, rows) =>
      error ? reject(error) : resolve(rows)
    )
  );
}

const ONE_ROW: FakeReply = {
  columns: [{ name: '1', type: FIELD_TYPE.LONGLONG }],
  rows: [['1']]
};

/** Answers TypeORM's startup query and anything else with one row. */
function typeOrmReplies(sql: string): FakeReply {
  return sql === 'SELECT version()'
    ? {
        columns: [{ name: 'version()', type: FIELD_TYPE.VAR_STRING }],
        rows: [['8.0.36']]
      }
    : ONE_ROW;
}

describe('createMysqlPool login timeout', () => {
  it('fails a stalled login after connectTimeout and serves the next queued request', async () => {
    const target = await start(
      { stallLogin: (id) => id === 1, onQuery: () => ONE_ROW },
      1_000,
      { connectionLimit: 1, connectTimeout: 300 }
    );
    const began = performance.now();
    const first = acquire(target);
    const second = acquire(target);
    const firstOutcome = await first.then(
      () => 'acquired',
      (error: { code?: string; message?: string }) => error
    );
    expect(firstOutcome).toMatchObject({
      code: 'ETIMEDOUT',
      message: 'connect ETIMEDOUT'
    });
    expect(performance.now() - began).toBeGreaterThanOrEqual(250);
    expect(performance.now() - began).toBeLessThan(2_000);
    const connection = await second;
    await expect(select(connection)).resolves.toEqual([{ 1: 1 }]);
    connection.release();
    expect(server!.stalledLogins).toEqual([1]);
    expect(server!.logins).toHaveLength(1);
  });

  it('leaves a completed login alone after connectTimeout has passed', async () => {
    const target = await start({ onQuery: () => ONE_ROW }, 1_000, {
      connectTimeout: 100
    });
    const connection = await acquire(target);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(select(connection)).resolves.toEqual([{ 1: 1 }]);
    connection.release();
  });

  it('fails TypeORM initialize() instead of hanging when its first login stalls', async () => {
    const port = await startServer({ stallLogin: () => true });
    const source = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port,
      username: 'u',
      password: 'p',
      database: 'd',
      connectTimeout: 300,
      ...mysql2TypeOrmOptions()
    });
    const began = performance.now();
    await expect(source.initialize()).rejects.toMatchObject({
      code: 'ETIMEDOUT'
    });
    expect(performance.now() - began).toBeLessThan(2_000);
    expect(source.isInitialized).toBe(false);
    expect(server!.stalledLogins).toEqual([1]);
  });
});

describe('createMysqlPool ping on reuse', () => {
  it('pings a reused connection but not a new one', async () => {
    const target = await start({});
    const first = await acquire(target);
    expect(server!.pings).toEqual([]);
    first.release();
    const again = await acquire(target);
    expect(again).toBe(first);
    expect(server!.pings).toEqual([1]);
    again.release();
  });

  it('replaces a connection whose ping fails', async () => {
    const target = await start({
      onPing: (id) =>
        id === 1
          ? {
              error: {
                errno: 1053,
                sqlState: '08S01',
                message: 'Server shutdown in progress'
              }
            }
          : undefined
    });
    const first = await acquire(target);
    first.release();
    const replacement = await acquire(target);
    expect(replacement).not.toBe(first);
    expect(server!.logins).toHaveLength(2);
    replacement.release();
  });

  it('replaces a connection whose ping does not answer in time', async () => {
    const target = await start(
      { onPing: (id) => (id === 1 ? { hang: true } : undefined) },
      50
    );
    const first = await acquire(target);
    first.release();
    const replacement = await acquire(target);
    expect(replacement).not.toBe(first);
    replacement.release();
  });

  it('pings once when a dropped connection wakes a waiting request', async () => {
    const target = await start({});
    const first = await acquire(target);
    const second = await acquire(target);
    // The pool is full, so this request waits in mysql2's queue.
    const waiting = acquire(target);
    // Dropping a connection hands the waiter back to getConnection on the
    // next tick; by then the second connection is idle and is reused.
    first.destroy();
    second.release();
    const woken = await waiting;
    expect(woken).toBe(second);
    expect(server!.pings).toEqual([2]);
    woken.release();
  });

  it('keeps listening for errors on pooled connections', async () => {
    const target = await start({});
    const connection = await acquire(target);
    connection.release();
    expect(() => {
      connection.emit('error', new Error('first'));
      connection.emit('error', new Error('second'));
    }).not.toThrow();
  });
});

describe('createMysqlPool under TypeORM', () => {
  it('gives the connection initialize() opens the permanent error listener', async () => {
    const port = await startServer({ onQuery: typeOrmReplies });
    const source = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port,
      username: 'u',
      password: 'p',
      database: 'd',
      ...mysql2TypeOrmOptions()
    });
    await source.initialize();
    try {
      const driverPool = (source.driver as MysqlDriver).pool as mysql.Pool;
      const initial = await acquire(driverPool);
      // Still the connection initialize() logged in with.
      expect(server!.logins).toHaveLength(1);
      expect(() => {
        initial.emit('error', new Error('first'));
        initial.emit('error', new Error('second'));
      }).not.toThrow();
      initial.release();
    } finally {
      await source.destroy();
    }
  });
});
