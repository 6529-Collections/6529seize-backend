import type { PoolConnection } from 'mysql2';
import { execNativeTransactionally } from '@/db/my-sql.helpers';
import {
  IDENTITY_FREEZE_AT_ENV,
  IDENTITY_FROZEN_CODE,
  IDENTITY_FROZEN_MESSAGE,
  IDENTITY_FROZEN_STATUS,
  IDENTITY_SWITCH_ON_AT_ENV,
  IdentityFrozenException
} from '@/identity-freeze/identity-freeze';
import { apiCompliantErrorBody } from '@/exceptions';
import type { ConnectionWrapper, SqlTransactionOptions } from '@/sql-executor';
import { Time } from '@/time';

/** Every setting that can freeze identity writes or switch them to the chain. */
export const IDENTITY_FREEZE_SETTINGS = [
  IDENTITY_FREEZE_AT_ENV,
  IDENTITY_SWITCH_ON_AT_ENV,
  'FEATURE_IDENTITY_FROZEN',
  'FEATURE_IDENTITY_ON_CHAIN'
] as const;

/**
 * A pooled mysql connection that records what the transaction helper sends
 * it: BEGIN, COMMIT, ROLLBACK, RELEASE and any query.
 */
export function fakePoolConnection(statements: string[] = []) {
  const release = jest.fn(() => {
    statements.push('RELEASE');
  });
  const connection = {
    query(sql: string, callback: (error: Error | null) => void) {
      statements.push(sql);
      callback(null);
    },
    beginTransaction(callback?: (error?: Error) => void) {
      statements.push('BEGIN');
      callback?.();
    },
    commit(callback: (error?: Error) => void) {
      statements.push('COMMIT');
      callback();
    },
    rollback(callback?: () => void) {
      statements.push('ROLLBACK');
      callback?.();
    },
    release
  } as unknown as PoolConnection;
  return { connection, statements, release };
}

/**
 * The transaction method of a db service, run by the real
 * `execNativeTransactionally` of my-sql.helpers on one fake pooled
 * connection, so BEGIN, the checks before COMMIT, COMMIT, ROLLBACK and
 * RELEASE happen as in production.
 */
export function fakeTransactionalDb() {
  const { connection, statements, release } = fakePoolConnection();
  const executeNativeQueriesInTransaction = jest.fn(
    <T>(
      work: (wrapper: ConnectionWrapper<any>) => Promise<T>,
      options?: SqlTransactionOptions
    ): Promise<T> => execNativeTransactionally(work, connection, options)
  );
  return { connection, statements, release, executeNativeQueriesInTransaction };
}

/**
 * Sets IDENTITY_FREEZE_AT to a time T and holds the clock (Time.currentMillis)
 * one second before it until `pass()`, which moves it one second after T:
 * a write let in before T whose transaction reaches COMMIT after it.
 * The other freeze settings are cleared; `restore()` puts everything back.
 */
export function freezeClock() {
  const saved = IDENTITY_FREEZE_SETTINGS.map(
    (name) => [name, process.env[name]] as const
  );
  for (const name of IDENTITY_FREEZE_SETTINGS) delete process.env[name];
  // Close to the real time, so code that also reads Date.now() (signature
  // deadlines) agrees with the mocked clock. Unix milliseconds, 13 digits.
  const T = Math.floor(Date.now() / 1000) * 1000 + 60_000;
  process.env[IDENTITY_FREEZE_AT_ENV] = String(T);
  let now = T - 1_000;
  const spy = jest.spyOn(Time, 'currentMillis').mockImplementation(() => now);
  return {
    T,
    spy,
    pass(): void {
      now = T + 1_000;
    },
    restore(): void {
      spy.mockRestore();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
}

/** Clears every freeze setting; the returned function puts them back. */
export function clearFreezeSettings(): () => void {
  const saved = IDENTITY_FREEZE_SETTINGS.map(
    (name) => [name, process.env[name]] as const
  );
  for (const name of IDENTITY_FREEZE_SETTINGS) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** What a call settled with: its value, or the error it threw. */
export async function settle(
  run: Promise<unknown>
): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await run };
  } catch (error) {
    return { error };
  }
}

/**
 * The call was refused with the freeze's own 423 IDENTITY_FROZEN and its
 * message, the transaction rolled back without a COMMIT, and the connection
 * went back to the pool.
 */
export async function expectRefusedAtCommit(
  run: Promise<unknown>,
  statements: string[],
  message: string = IDENTITY_FROZEN_MESSAGE
): Promise<void> {
  const { error } = await settle(run);
  expect(error).toBeInstanceOf(IdentityFrozenException);
  const refused = error as IdentityFrozenException;
  expect(refused.getStatusCode()).toBe(IDENTITY_FROZEN_STATUS);
  expect(apiCompliantErrorBody(refused)).toEqual({
    error: message,
    code: IDENTITY_FROZEN_CODE
  });
  expect(statements).toContain('BEGIN');
  expect(statements).not.toContain('COMMIT');
  expect(statements.slice(-2)).toEqual(['ROLLBACK', 'RELEASE']);
}

/** The transaction committed once and the connection went back to the pool. */
export function expectCommitted(statements: string[]): void {
  expect(statements.filter((it) => it === 'COMMIT')).toHaveLength(1);
  expect(statements).not.toContain('ROLLBACK');
  expect(statements.slice(-2)).toEqual(['COMMIT', 'RELEASE']);
}
