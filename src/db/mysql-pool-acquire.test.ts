import * as mysql from 'mysql2';
import { checkPooledConnectionsOnAcquire } from './mysql-pool-acquire';
import {
  FakeMysqlServer,
  FakeMysqlServerOptions
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

async function start(
  options: FakeMysqlServerOptions,
  acquireTimeoutMs = 1_000
): Promise<mysql.Pool> {
  server = new FakeMysqlServer(options);
  const port = await server.start();
  pool = mysql.createPool({
    host: '127.0.0.1',
    port,
    user: 'u',
    password: 'p',
    connectionLimit: 2
  });
  checkPooledConnectionsOnAcquire(pool, acquireTimeoutMs);
  return pool;
}

function acquire(target: mysql.Pool): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) =>
    target.getConnection((error, connection) =>
      error ? reject(error) : resolve(connection)
    )
  );
}

describe('checkPooledConnectionsOnAcquire', () => {
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
