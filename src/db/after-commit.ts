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

/**
 * Runs the callbacks together and waits for them up to a short budget.
 * Failures are logged, never thrown: the transaction is already committed.
 */
export async function runAfterCommitCallbacks(
  callbacks: AfterCommitCallback[]
): Promise<void> {
  if (!callbacks.length) {
    return;
  }
  const settled = Promise.allSettled(
    callbacks.map((callback) => Promise.resolve().then(callback))
  ).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('After-commit callback failed', result.reason);
      }
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, AFTER_COMMIT_WAIT_MS);
        timer.unref?.();
      })
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
 * Runs `check` as the last step of the transaction that owns `connection`,
 * right before its COMMIT. A check that throws rolls the whole transaction
 * back, and the caller gets its error. Checks sharing a `key` run once.
 * Without a tracked transaction (no connection, or a transaction helper that
 * does not track it) the write commits on its own, so `check` runs now.
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
