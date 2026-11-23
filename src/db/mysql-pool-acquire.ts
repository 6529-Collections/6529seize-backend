import type { Pool, PoolConnection } from 'mysql2';

type GetConnectionCallback = Parameters<Pool['getConnection']>[0];

/**
 * Keeps the acquire-time check mysqljs made. mysqljs pinged a pooled
 * connection each time it handed it out again and, when the ping failed or
 * took longer than its acquireTimeout, dropped it and took another one. A
 * socket that RDS Proxy closed while a Lambda was frozen therefore never
 * reached a query. mysql2 hands idle connections out unchecked.
 *
 * New connections are handed out as soon as they have logged in, as before.
 * A connection that fails the check is destroyed and the caller asks the pool
 * again, so it can wait behind requests that queued meanwhile.
 *
 * It also gives every new connection a permanent 'error' listener, as mysqljs
 * did. mysql2 listens for a pooled connection's first error only; a later one
 * on a broken idle connection would surface as an unhandled 'error' event.
 */
export function checkPooledConnectionsOnAcquire(
  pool: Pool,
  acquireTimeoutMs: number
): void {
  const justOpened = new WeakSet<PoolConnection>();
  pool.on('connection', (connection: PoolConnection) => {
    justOpened.add(connection);
    connection.on('error', () => {
      // mysql2 has already taken the connection out of the pool.
    });
  });
  const getConnection = pool.getConnection.bind(pool);
  const acquire = (callback: GetConnectionCallback): void => {
    getConnection((error, connection) => {
      if (error || justOpened.delete(connection)) {
        callback(error, connection);
        return;
      }
      pingWithin(connection, acquireTimeoutMs, (alive) =>
        alive ? callback(null, connection) : acquire(callback)
      );
    });
  };
  pool.getConnection = acquire;
}

function pingWithin(
  connection: PoolConnection,
  timeoutMs: number,
  done: (alive: boolean) => void
): void {
  let settled = false;
  const finish = (alive: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!alive) {
      try {
        connection.destroy();
      } catch {
        // A connection that cannot even be closed is still never reused.
      }
    }
    done(alive);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  try {
    connection.ping((error) => finish(!error));
  } catch {
    finish(false);
  }
}
