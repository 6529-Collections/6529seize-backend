import { Logger } from '@/logging';
import type { ConnectionWrapper } from '@/sql-executor';

type AfterCommitCallback = () => unknown;

interface PendingCallback {
  readonly key: string | null;
  readonly callback: AfterCommitCallback;
}

const logger = Logger.get('AFTER_COMMIT');
const pendingByConnection = new WeakMap<object, PendingCallback[]>();
/** Checks to run right before COMMIT, by key; only for a transaction that registered one. */
const checksByConnection = new WeakMap<object, Map<string, () => void>>();
/** Commit-path budget for callbacks; slower ones finish in the background. */
const AFTER_COMMIT_WAIT_MS = 1_000;

/** Transaction helpers call this right after BEGIN on `connection`. */
export function openAfterCommitScope(connection: object): void {
  pendingByConnection.set(connection, []);
  checksByConnection.delete(connection);
}

/**
 * Transaction helpers call this after COMMIT (and run the result) or after
 * ROLLBACK (and drop it).
 */
export function closeAfterCommitScope(
  connection: object
): AfterCommitCallback[] {
  const pending = pendingByConnection.get(connection) ?? [];
  pendingByConnection.delete(connection);
  checksByConnection.delete(connection);
  return pending.map(({ callback }) => callback);
}

/** Marks a callback registered with afterCommitAwaited. */
const AWAITED = Symbol('afterCommitAwaited');

function isAwaited(callback: AfterCommitCallback): boolean {
  return (callback as { [AWAITED]?: true })[AWAITED] === true;
}

/**
 * Runs the callbacks together and waits for them up to a short budget, and
 * for those registered with afterCommitAwaited in full. Failures are
 * logged, never thrown: the transaction is already committed.
 */
export async function runAfterCommitCallbacks(
  callbacks: AfterCommitCallback[]
): Promise<void> {
  if (!callbacks.length) {
    return;
  }
  const runs = callbacks.map((callback) => ({
    awaited: isAwaited(callback),
    done: Promise.resolve()
      .then(callback)
      .then(
        () => undefined,
        (error) => {
          logger.warn('After-commit callback failed', error);
        }
      )
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([
      Promise.all(runs.filter((run) => run.awaited).map((run) => run.done)),
      Promise.race([
        Promise.all(runs.filter((run) => !run.awaited).map((run) => run.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, AFTER_COMMIT_WAIT_MS);
          timer.unref?.();
        })
      ])
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `callback` once the transaction that owns `connection` commits, and
 * never when it rolls back. Without a tracked transaction (no connection, an
 * autocommit statement, or a transaction helper that does not track
 * callbacks) it runs now. Callbacks sharing a `key` run once per commit.
 */
export async function afterCommit(
  connection: ConnectionWrapper<any> | undefined,
  callback: AfterCommitCallback,
  key: string | null = null
): Promise<void> {
  const pending =
    connection?.connection && typeof connection.connection === 'object'
      ? pendingByConnection.get(connection.connection)
      : undefined;
  if (!pending) {
    await runAfterCommitCallbacks([callback]);
    return;
  }
  if (key !== null && pending.some((entry) => entry.key === key)) {
    return;
  }
  pending.push({ key, callback });
}

/**
 * As afterCommit, but the transaction helper waits for `callback` in full,
 * past the usual budget, before it returns to its caller: for work that
 * must finish, or record its own failure, before the request or the Lambda
 * invocation ends. Without a tracked transaction it runs now, and is waited
 * for. Its failures are logged, never thrown.
 *
 * A connection given with no tracked transaction is logged: the callback
 * then runs while that connection's own transaction, if any, is still open,
 * and would wait on any lock it holds.
 */
export async function afterCommitAwaited(
  connection: ConnectionWrapper<any> | undefined,
  callback: AfterCommitCallback
): Promise<void> {
  const awaited = Object.assign(() => callback(), {
    [AWAITED]: true as const
  });
  const pending =
    connection?.connection && typeof connection.connection === 'object'
      ? pendingByConnection.get(connection.connection)
      : undefined;
  if (!pending) {
    if (connection?.connection) {
      logger.warn(
        'afterCommitAwaited got a connection with no tracked transaction; running the callback now'
      );
    }
    await runAfterCommitCallbacks([awaited]);
    return;
  }
  pending.push({ key: null, callback: awaited });
}

/** Where a transaction's after-commit work stood when a savepoint was set. */
export interface AfterCommitMark {
  readonly callbacks: number;
  readonly checks: ReadonlySet<string>;
}

/**
 * Marks the after-commit work registered so far on the transaction that owns
 * `connection`, right after a SAVEPOINT. Null without a tracked transaction.
 */
export function afterCommitMark(
  connection: ConnectionWrapper<any> | undefined
): AfterCommitMark | null {
  const handle = connection?.connection;
  const pending =
    handle && typeof handle === 'object'
      ? pendingByConnection.get(handle)
      : undefined;
  if (!pending) {
    return null;
  }
  return {
    callbacks: pending.length,
    checks: new Set(checksByConnection.get(handle)?.keys() ?? [])
  };
}

/**
 * After a ROLLBACK TO SAVEPOINT: drops the callbacks and checks registered
 * since `mark`, so work the savepoint undid has no after-commit effect.
 */
export function dropAfterCommitSince(
  connection: ConnectionWrapper<any> | undefined,
  mark: AfterCommitMark | null
): void {
  const handle = connection?.connection;
  if (!mark || !handle || typeof handle !== 'object') {
    return;
  }
  pendingByConnection.get(handle)?.splice(mark.callbacks);
  const checks = checksByConnection.get(handle);
  checks?.forEach((_, key) => {
    if (!mark.checks.has(key)) {
      checks.delete(key);
    }
  });
}

/**
 * Runs `check` as the last step of the transaction that owns `connection`,
 * right before its COMMIT. A check that throws rolls the whole transaction
 * back, and the caller gets its error. Checks sharing a `key` run once.
 * Without a tracked transaction (no connection, or a transaction helper that
 * does not track it) nothing would run it at COMMIT, so `check` runs now.
 * A transaction that registers nothing does no extra work.
 */
export function beforeCommit(
  connection: ConnectionWrapper<any> | undefined,
  key: string,
  check: () => void
): void {
  const handle = connection?.connection;
  if (
    !handle ||
    typeof handle !== 'object' ||
    !pendingByConnection.has(handle)
  ) {
    check();
    return;
  }
  let checks = checksByConnection.get(handle);
  if (!checks) {
    checks = new Map();
    checksByConnection.set(handle, checks);
  }
  if (!checks.has(key)) {
    checks.set(key, check);
  }
}

/**
 * Transaction helpers call this right before COMMIT on `connection`: it runs
 * the registered checks, in the order they were registered, and throws the
 * first failure.
 */
export function runBeforeCommitChecks(connection: object): void {
  const checks = checksByConnection.get(connection);
  if (!checks) {
    return;
  }
  checks.forEach((check) => check());
}
