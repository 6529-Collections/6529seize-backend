import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolConnection } from 'mysql';
import { Logger } from '@/logging';
import { loggerContext } from '@/logger-context';

/**
 * RDS Proxy pins a client session to one database connection for the rest of
 * that client connection's life once it sees a statement over 16,384 bytes or
 * a session-setting change it cannot track. Lambda containers keep pooled
 * client connections warm, so a pinned session would otherwise hold a database
 * connection across idle time until the container dies.
 *
 * Inside a request scope a pinned connection keeps returning to the pool, so
 * later statements of the same request reuse it without reconnecting; the
 * scope retires it when the request ends. Outside a scope (or after it ended)
 * a pinned connection is retired when it is released. A retired connection
 * never returns to the pool.
 *
 * The threshold leaves headroom below the proxy limit for protocol framing.
 */
export const PROXY_PIN_STATEMENT_BYTES = 16_000;

export type ProxyPinReason = 'oversized_statement' | 'session_settings';

/** Pool dimension: the API read/write pool or a write-pool transaction. */
export type ProxyPinPool = 'READ' | 'WRITE' | 'TRANSACTION';

export interface ProxySessionPin {
  readonly reason: ProxyPinReason;
  /** Normalized statement prefix. Never contains bound or inlined values. */
  readonly fingerprint?: string;
  readonly statementBytes?: number;
}

/** When a pinned session was retired: at its own release or at request end. */
export type ProxyPinRetirement = 'release' | 'request_end';

/**
 * `destroyed`: the driver closed it. `quarantined`: destroy threw, so it was
 * taken out of the pool's idle list and will never be released again; mysql
 * drops it from the pool when its socket ends.
 */
export type ProxyRetireOutcome = 'destroyed' | 'quarantined';

const FINGERPRINT_CHARS = 120;
const METRIC_NAMESPACE = '6529/DbProxy';
const logger = Logger.get('DB_PROXY_PINNING');
const pinnedSessions = new WeakMap<object, ProxySessionPin>();
const quarantined = new WeakSet<object>();
/**
 * Pinned connections still borrowed when their request ended. Every later
 * request end re-checks them, so one released without passing through this
 * module still gets retired. Bounded by the pools' connection limits.
 */
const deferredPins = new Map<PoolConnection, ProxyPinPool>();

interface ProxyPinScope {
  closed: boolean;
  readonly pinned: Map<PoolConnection, ProxyPinPool>;
}

const scopes = new AsyncLocalStorage<ProxyPinScope>();

/**
 * Returns the UTF-8 size of a statement that exceeds the pinning threshold, or
 * null. A UTF-16 code unit encodes to at most three UTF-8 bytes, so ordinary
 * statements are decided from their length without encoding.
 */
export function oversizedStatementBytes(sql: string): number | null {
  if (sql.length * 3 <= PROXY_PIN_STATEMENT_BYTES) return null;
  const bytes = Buffer.byteLength(sql, 'utf8');
  return bytes > PROXY_PIN_STATEMENT_BYTES ? bytes : null;
}

// One left-to-right alternation, so a quote inside a comment (or the reverse)
// cannot shift literal boundaries and expose a value.
const SQL_FINGERPRINT_TOKEN = new RegExp(
  [
    /\/\*[\s\S]*?\*\//, // block comment
    /--[^\n]*/, // line comment
    /#[^\n]*/, // line comment
    /'(?:[^'\\]|\\[\s\S])*'/, // single-quoted literal
    /"(?:[^"\\]|\\[\s\S])*"/, // double-quoted literal
    /`(?:[^`]|``)*`/, // quoted identifier (kept)
    /\b0x[0-9a-f]+\b/, // hex literal
    /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/ // numeric literal
  ]
    .map((token) => token.source)
    .join('|'),
  'gi'
);

/**
 * Low-cardinality statement label for diagnostics: comments removed, string,
 * hex and numeric literals replaced with `?`, literal lists collapsed. Pass
 * the statement template, not the formatted SQL; inlined values are scrubbed
 * either way. Anything after an unterminated quote is dropped before the
 * length cap, so a cut can never expose part of a literal.
 */
export function sqlFingerprint(sql: string): string {
  const scrubbed = sql
    .replace(SQL_FINGERPRINT_TOKEN, (token) => {
      const first = token[0];
      if (first === '`') return token;
      if (first === '/' || first === '-' || first === '#') return ' ';
      return '?';
    })
    .replace(/\s+/g, ' ')
    .replace(/\?(?:\s*,\s*\?)+/g, '?+')
    .replace(/\(\s*\?\+?\s*\)(?:\s*,\s*\(\s*\?\+?\s*\))+/g, '(?+)+');
  const unterminated = scrubbed.search(/['"]/);
  const safe = unterminated === -1 ? scrubbed : scrubbed.slice(0, unterminated);
  return safe.trim().slice(0, FINGERPRINT_CHARS).trim();
}

/** Records that a borrowed connection's proxy session is pinned. First pin wins. */
export function markProxySessionPinned(
  connection: object,
  pin: ProxySessionPin
): void {
  if (!pinnedSessions.has(connection)) pinnedSessions.set(connection, pin);
}

export function isProxySessionPinned(connection: object): boolean {
  return pinnedSessions.has(connection);
}

/**
 * Takes a pooled connection out of circulation so the proxy frees its pinned
 * database connection. It is destroyed (mysql removes it from its pool and
 * opens a replacement on demand). If destroy throws, the connection may be
 * half-closed, so it is quarantined instead of ever being released again.
 * Never throws.
 */
export function retireProxySession(
  connection: PoolConnection,
  pool: ProxyPinPool,
  pin: ProxySessionPin,
  when: ProxyPinRetirement = 'release'
): ProxyRetireOutcome {
  pinnedSessions.delete(connection);
  deferredPins.delete(connection);
  try {
    connection.destroy();
  } catch {
    quarantine(connection);
    try {
      logger.warn('[DB_PROXY_PIN_RETIRE_FAILED]', {
        pool,
        reason: pin.reason,
        when
      });
    } catch {
      // Logging cannot undo the quarantine.
    }
    return 'quarantined';
  }
  recordProxySessionRetired(pool, pin, when);
  return 'destroyed';
}

/**
 * Ends a borrow. Unpinned connections, and pinned ones inside an open request
 * scope, return to the pool; the scope retires pinned ones at request end. A
 * pinned connection released outside an open scope is retired now. A
 * quarantined connection is never released.
 */
export function releaseOrRetireProxySession(
  connection: PoolConnection,
  pool: ProxyPinPool
): void {
  if (quarantined.has(connection)) return;
  const pin = pinnedSessions.get(connection);
  if (!pin) {
    connection.release();
    return;
  }
  const scope = scopes.getStore();
  if (scope && !scope.closed) {
    scope.pinned.set(connection, pool);
    deferredPins.delete(connection);
    connection.release();
    return;
  }
  retireProxySession(connection, pool, pin);
}

/**
 * Runs one request or invocation in a pin scope. When it settles, also on
 * error, pinned connections idle in their pool are retired. One still borrowed
 * (background work) is never touched mid-query: it is retired at its next
 * release outside an open scope, or by a later request end once it is idle.
 */
export async function withProxyPinScope<T>(work: () => Promise<T>): Promise<T> {
  const scope: ProxyPinScope = { closed: false, pinned: new Map() };
  try {
    return await scopes.run(scope, work);
  } finally {
    retireScopePins(scope);
  }
}

function retireScopePins(scope: ProxyPinScope): void {
  scope.closed = true;
  const candidates = new Map([
    ...Array.from(deferredPins),
    ...Array.from(scope.pinned)
  ]);
  scope.pinned.clear();
  if (!candidates.size) return;
  let retired = 0;
  let deferred = 0;
  for (const [connection, pool] of Array.from(candidates)) {
    const pin = pinnedSessions.get(connection);
    const state = pin ? poolState(connection) : 'gone';
    if (!pin || state === 'gone') {
      // Already retired, or dropped by the driver: nothing left to hand out.
      pinnedSessions.delete(connection);
      deferredPins.delete(connection);
    } else if (state === 'borrowed') {
      deferredPins.set(connection, pool);
      deferred++;
    } else {
      retireProxySession(connection, pool, pin, 'request_end');
      retired++;
    }
  }
  if (retired || deferred) recordRequestRetirements(retired, deferred);
}

/**
 * mysql 2.x keeps released connections in `pool._freeConnections` (see
 * Pool#releaseConnection) and clears `_pool` when it drops a connection. Any
 * other shape counts as borrowed, so it is never destroyed mid-query.
 */
function poolState(connection: PoolConnection): 'idle' | 'borrowed' | 'gone' {
  const pool = (connection as unknown as { _pool?: unknown })._pool;
  if (!pool) return 'gone';
  return idleList(connection)?.includes(connection) ? 'idle' : 'borrowed';
}

function idleList(connection: PoolConnection): unknown[] | undefined {
  const pool = (connection as unknown as { _pool?: unknown })._pool as
    | { _freeConnections?: unknown }
    | null
    | undefined;
  return Array.isArray(pool?._freeConnections)
    ? pool._freeConnections
    : undefined;
}

function quarantine(connection: PoolConnection): void {
  quarantined.add(connection);
  // An idle connection must not be handed to the next borrower.
  const idle = idleList(connection);
  const index = idle ? idle.indexOf(connection) : -1;
  if (idle && index !== -1) idle.splice(index, 1);
}

function metricEnvironment(): string {
  return (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
}

function recordRequestRetirements(retired: number, deferred: number): void {
  try {
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
      logger.info('[DB_PROXY_PINS_AT_REQUEST_END]', { retired, deferred });
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [['Environment']],
              Metrics: [
                { Name: 'ProxyPinnedSessionsRetiredPerRequest', Unit: 'Count' }
              ]
            }
          ]
        },
        Environment: metricEnvironment(),
        ProxyPinnedSessionsRetiredPerRequest: retired,
        event: 'db_proxy_pins_at_request_end',
        deferred,
        request_id: loggerContext.get()?.requestId ?? null
      })}\n`
    );
  } catch {
    // Telemetry must never fail a request.
  }
}

function recordProxySessionRetired(
  pool: ProxyPinPool,
  pin: ProxySessionPin,
  when: ProxyPinRetirement
): void {
  try {
    const requestId = loggerContext.get()?.requestId ?? null;
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
      logger.info('[DB_PROXY_PIN_RETIRED]', {
        pool,
        reason: pin.reason,
        when,
        fingerprint: pin.fingerprint ?? null,
        statement_bytes: pin.statementBytes ?? null
      });
      return;
    }
    const metrics: { Name: string; Unit: string }[] = [
      { Name: 'ProxyPinnedSessionRetired', Unit: 'Count' }
    ];
    if (pin.statementBytes !== undefined)
      metrics.push({ Name: 'ProxyPinStatementBytes', Unit: 'Bytes' });
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              Dimensions: [['Environment', 'Pool', 'Reason', 'When']],
              Metrics: metrics
            }
          ]
        },
        Environment: metricEnvironment(),
        Pool: pool,
        Reason: pin.reason,
        When: when,
        ProxyPinnedSessionRetired: 1,
        ...(pin.statementBytes === undefined
          ? {}
          : { ProxyPinStatementBytes: pin.statementBytes }),
        event: 'db_proxy_pin_retired',
        fingerprint: pin.fingerprint ?? null,
        request_id: requestId
      })}\n`
    );
  } catch {
    // Telemetry must never fail a query or keep a pinned session alive.
  }
}
