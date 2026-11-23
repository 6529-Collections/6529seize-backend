import * as net from 'node:net';
import * as mysql from 'mysql2';
import type { Pool, PoolConnection, PoolOptions } from 'mysql2';

type GetConnectionCallback = Parameters<Pool['getConnection']>[0];

export interface MysqlPoolGuards {
  /** How long a reused connection's ping may take: mysqljs's acquireTimeout. */
  readonly acquireTimeoutMs: number;
}

/** One request for a connection, and the login timer of one opened for it. */
interface Acquisition {
  loginTimer?: ReturnType<typeof setTimeout>;
  settled?: boolean;
}

/** The resolved connection settings mysql2 passes to a `stream` factory. */
interface SocketSettings {
  readonly host: string;
  readonly port: number;
  readonly socketPath?: string;
  readonly enableKeepAlive?: boolean;
  readonly keepAliveInitialDelay?: number;
  readonly connectTimeout?: number;
}

/**
 * A mysql2 pool that keeps the checks mysqljs made when it handed out a
 * connection.
 *
 * - Login timeout. mysqljs bounded a new connection from socket open to the
 *   end of its login. mysql2's connectTimeout stops at the server's first
 *   bytes, so a login that stalls after the greeting (including IAM token
 *   signing) would wait forever while holding a pool slot. Here the pool's
 *   connectTimeout runs until the login completes; on expiry the socket is
 *   destroyed with ETIMEDOUT, the pool drops the connection and frees its
 *   slot, and only the request waiting for that connection fails.
 * - Ping on reuse. mysqljs pinged a pooled connection each time it handed it
 *   out again and, when the ping failed or took longer than acquireTimeout,
 *   dropped it and took another one, so a socket that RDS Proxy closed while
 *   a Lambda was frozen never reached a query. A failed connection is
 *   destroyed and the caller asks the pool again, so it can wait behind
 *   requests that queued meanwhile.
 * - Error listener. Every new connection keeps an 'error' listener, as with
 *   mysqljs. mysql2 listens for a pooled connection's first error only; a
 *   later one on a broken idle connection would be an unhandled 'error'.
 * - Closing. pool.end() fails requests still waiting for a connection with
 *   POOL_CLOSED, as mysqljs did; mysql2 would leave them pending.
 *
 * mysql2 opens a connection's socket through the `stream` factory while
 * pool.getConnection() runs, so the socket is tied to the request that is
 * opening it without reading driver internals.
 */
export function createMysqlPool(
  options: PoolOptions,
  guards: MysqlPoolGuards
): Pool {
  let opening: Acquisition | null = null;
  const pool = mysql.createPool({
    ...options,
    stream: ({ config }: { config: SocketSettings }) =>
      openSocket(config, opening)
  });
  const justOpened = new WeakSet<PoolConnection>();
  // Registered before the pool opens anything, so the first connection, such
  // as the one TypeORM opens inside initialize(), gets the listener too.
  pool.on('connection', (connection: PoolConnection) => {
    justOpened.add(connection);
    connection.on('error', () => {
      // mysql2 has already taken the connection out of the pool.
    });
  });
  const acquisitions = new WeakMap<GetConnectionCallback, Acquisition>();
  // Hand-outs waiting in mysql2's queue, for pool.end() to fail.
  const waiting = new Set<GetConnectionCallback>();
  let requesting: GetConnectionCallback | null = null;
  pool.on('enqueue', () => {
    if (requesting) waiting.add(requesting);
  });
  const getConnection = pool.getConnection.bind(pool);
  const acquire = (callback: GetConnectionCallback): void => {
    // mysql2 hands a queued callback back to getConnection when a connection
    // is dropped. It is not wrapped again: it keeps its acquisition, and a
    // checkout pings the connection it receives at most once.
    let handOut = callback;
    let acquisition = acquisitions.get(callback);
    if (!acquisition) {
      const state: Acquisition = {};
      acquisition = state;
      handOut = (error, connection) => {
        waiting.delete(handOut);
        if (state.settled) return;
        clearTimeout(state.loginTimer);
        state.loginTimer = undefined;
        if (error || justOpened.delete(connection)) {
          state.settled = true;
          callback(error, connection);
          return;
        }
        state.settled = true;
        pingWithin(connection, guards.acquireTimeoutMs, (alive) =>
          alive ? callback(null, connection) : acquire(callback)
        );
      };
      acquisitions.set(handOut, state);
    }
    opening = acquisition;
    requesting = handOut;
    try {
      getConnection(handOut);
    } finally {
      opening = null;
      requesting = null;
    }
  };
  pool.getConnection = acquire;
  const end = pool.end.bind(pool);
  pool.end = (callback?: Parameters<Pool['end']>[0]): void => {
    const unserved = Array.from(waiting);
    waiting.clear();
    end(callback);
    for (const handOut of unserved) {
      process.nextTick(() =>
        handOut(poolClosedError(), undefined as unknown as PoolConnection)
      );
    }
  };
  return pool;
}

/** The error mysqljs gave requests still waiting when a pool was closed. */
function poolClosedError(): Error {
  return Object.assign(new Error('Pool is closed.'), { code: 'POOL_CLOSED' });
}

/**
 * mysql2 for TypeORM's `driver` option, so a data source's pool, including
 * the connection initialize() opens, gets the same checks.
 */
export function mysql2TypeOrmDriver(guards: MysqlPoolGuards) {
  return {
    ...mysql,
    createPool: (options: PoolOptions) => createMysqlPool(options, guards)
  };
}

/** The socket mysql2 would open itself, with a login timer when a request opens it. */
function openSocket(
  settings: SocketSettings,
  acquisition: Acquisition | null
): net.Socket {
  let socket: net.Socket;
  if (settings.socketPath) {
    socket = net.connect(settings.socketPath);
  } else {
    socket = net.connect(settings.port, settings.host);
    if (settings.enableKeepAlive) {
      socket.on('connect', () =>
        socket.setKeepAlive(true, settings.keepAliveInitialDelay)
      );
    }
    socket.setNoDelay(true);
  }
  // Every pool socket is opened inside acquire(). One opened any other way
  // has no request to clear its timer, so it keeps mysql2's own timeout.
  if (acquisition && settings.connectTimeout) {
    acquisition.loginTimer = setTimeout(
      () => socket.destroy(loginTimeoutError()),
      settings.connectTimeout
    );
  }
  return socket;
}

/** The error mysql2 raises when a server does not answer within connectTimeout. */
function loginTimeoutError(): Error {
  return Object.assign(new Error('connect ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    errorno: 'ETIMEDOUT',
    syscall: 'connect'
  });
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
      // mysql2's destroy() only sends FIN; mysqljs closed the socket at once,
      // which a dead or unresponsive peer needs.
      const socket = (connection as unknown as { stream?: net.Socket }).stream;
      try {
        connection.destroy();
      } catch {
        // A connection that cannot even be closed is still never reused.
      } finally {
        socket?.destroy();
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
