import { createHash } from 'node:crypto';

// Shared helpers for the explicit operator cleanups in this folder. Never imported by a Lambda handler.

export interface SqlRunner {
  query(sql: string, parameters?: unknown[]): Promise<any>;
}

export interface BackupSink {
  write(table: string, rows: readonly object[]): void;
}

export interface BatchOptions {
  batchSize?: number;
  pauseMs?: number;
  log?: (message: string) => void;
}

export interface BatchSettings {
  batchSize: number;
  pauseMs: number;
  log: (message: string) => void;
}

export function batchSettings(
  options: BatchOptions,
  defaultBatchSize: number
): BatchSettings {
  return {
    batchSize: options.batchSize ?? defaultBatchSize,
    pauseMs: options.pauseMs ?? 0,
    log: options.log ?? (() => undefined)
  };
}

export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sha256Lines(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(`${value}\n`);
  return hash.digest('hex');
}

export function placeholders(values: readonly unknown[]): string {
  if (!values.length) throw new Error('Expected at least one SQL value');
  return values.map(() => '?').join(', ');
}

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Invalid database identifier: ${value}`);
  }
  return `\`${value}\``;
}

export async function scalar(
  runner: SqlRunner,
  sql: string,
  params: unknown[] = []
): Promise<number> {
  const [row] = await runner.query(sql, params);
  return Number(Object.values(row ?? { value: 0 })[0] ?? 0);
}

export async function currentDatabase(runner: SqlRunner): Promise<string> {
  const [{ database }]: { database: string }[] = await runner.query(
    'SELECT DATABASE() AS `database`'
  );
  return database;
}

export async function inTransaction<T>(
  runner: SqlRunner,
  work: () => Promise<T>
): Promise<T> {
  await runner.query('START TRANSACTION');
  try {
    const result = await work();
    await runner.query('COMMIT');
    return result;
  } catch (error) {
    await runner.query('ROLLBACK');
    throw error;
  }
}

export async function withNamedLock<T>(
  runner: SqlRunner,
  name: string,
  work: () => Promise<T>
): Promise<T> {
  const [lock]: { acquired: number | string | null }[] = await runner.query(
    'SELECT GET_LOCK(?, 0) AS acquired',
    [name]
  );
  if (Number(lock.acquired) !== 1) {
    throw new Error(`Another ${name} operation is running`);
  }
  try {
    return await work();
  } finally {
    await runner.query('SELECT RELEASE_LOCK(?)', [name]);
  }
}

export async function pause(ms: number) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockConflict(error: unknown): boolean {
  const failure = error as {
    code?: string;
    driverError?: { code?: string };
  } | null;
  const code = failure?.driverError?.code ?? failure?.code;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

/** Retries a whole transaction that lost a lock race with live traffic. */
export async function retryOnLockConflict<T>(
  work: () => Promise<T>,
  attempts = 5
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isLockConflict(error)) throw error;
      await pause(250 * attempt);
    }
  }
}

export function affectedRows(result: unknown): number {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows: unknown }).affectedRows ?? 0);
  }
  return 0;
}
