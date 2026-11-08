import { DataSource, QueryRunner } from 'typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder';
import { Logger } from '@/logging';

/**
 * Every schema statement waits at most this long for its metadata lock.
 * While an ALTER waits behind a running transaction on its table, every new
 * reader and writer of that table queues behind the ALTER, so the wait must
 * be short; the session default is a year.
 */
export const SCHEMA_SYNC_LOCK_WAIT_SECONDS = 3;
export const SCHEMA_SYNC_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];
/** Executions per statement: the first try plus one per retry delay. */
export const SCHEMA_SYNC_ATTEMPTS = SCHEMA_SYNC_RETRY_DELAYS_MS.length + 1;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const LOGGED_SQL_CHARS = 300;

const logger = Logger.get('SCHEMA_SYNC');

type Sleep = (ms: number) => Promise<void>;

export interface SchemaSyncResult {
  readonly planned: number;
  readonly applied: number;
}

export class SchemaSyncLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaSyncLockedError';
  }
}

function isLockWaitTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidates = [error, (error as { driverError?: unknown }).driverError];
  return candidates.some(
    (it) =>
      !!it &&
      typeof it === 'object' &&
      (('errno' in it && it.errno === ER_LOCK_WAIT_TIMEOUT) ||
        ('code' in it && it.code === 'ER_LOCK_WAIT_TIMEOUT'))
  );
}

const shortSql = (sql: string) =>
  sql.replace(/\s+/g, ' ').trim().slice(0, LOGGED_SQL_CHARS);

/** The table a schema statement targets, for logs and errors. */
function statementTarget(sql: string): string {
  const match =
    /\b(?:table|on|into|update)\s+(?:`[^`]+`\.)?`([^`]+)`/i.exec(sql) ??
    /\b(?:table|on|into|update)\s+(\S+)/i.exec(sql);
  return match?.[1] ?? 'unknown table';
}

/** MySQL's own default, used if the session value can't be read back. */
const MYSQL_DEFAULT_LOCK_WAIT_SECONDS = 31536000;

/**
 * EMF metric, labelled like the DB proxy metrics (staging, else prod).
 * Outside Lambda the matching log line is the signal.
 */
function emitMetric(
  name: 'SchemaSyncLockTimeout' | 'SchemaSyncFailed',
  outcome: string,
  table: string
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/SchemaSync',
              Dimensions: [['Environment', 'Outcome']],
              Metrics: [{ Name: name, Unit: 'Count' }]
            }
          ]
        },
        Environment: (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
          ? 'staging'
          : 'prod',
        Outcome: outcome,
        [name]: 1,
        table
      })}\n`
    );
  } catch {
    // Metrics never change the outcome.
  }
}

/**
 * Applies what TypeORM's synchronize() would, with bounded metadata-lock waits.
 *
 * synchronize() runs its DDL under the session's default lock wait (a year),
 * so one ALTER queued behind a long transaction stalls every reader and
 * writer of that table until it gets the lock. Instead:
 * - Plan with the schema builder's log(): the exact statements synchronize()
 *   would run, in its order (TypeORM's migration generator uses the same
 *   plan), including its typeorm_metadata bookkeeping for generated columns.
 *   Planning only reads the catalog, so it never blocks other sessions.
 * - No statements: no DDL at all.
 * - Otherwise apply them one by one on one connection whose
 *   lock_wait_timeout is SCHEMA_SYNC_LOCK_WAIT_SECONDS. A lock timeout is
 *   retried with backoff; after SCHEMA_SYNC_ATTEMPTS the run fails, naming the
 *   table and the applied and remaining statements. Nothing is killed.
 *
 * MySQL DDL commits per statement, so a failed run leaves the statements
 * before the failing one applied. The next run plans again from the live
 * schema and applies only what is still missing.
 */
export async function synchronizeSchemaBounded(
  dataSource: DataSource,
  options: { sleep?: Sleep } = {}
): Promise<SchemaSyncResult> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const builder = dataSource.driver.createSchemaBuilder() as RdbmsSchemaBuilder;
  const queryRunner = dataSource.createQueryRunner('master');
  let applied = 0;
  let planned: { query: string; parameters?: unknown[] }[] = [];
  try {
    await queryRunner.connect();
    const restoreLockWait = await shortenLockWait(queryRunner);
    try {
      // synchronize() creates TypeORM's own metadata table first, if any
      // entity needs it (generated columns); the plan writes to it. This
      // calls a protected TypeORM 0.3 method: on a TypeORM upgrade, re-check
      // it and log() here (bounded-schema-sync.db.test.ts pins the behaviour).
      await withLockRetry(
        () => builder['createMetadataTableIfNecessary'](queryRunner),
        'typeorm_metadata',
        sleep
      );
      planned = (await builder.log()).upQueries;
      logger.info('[SCHEMA_SYNC_PLAN]', {
        statements: planned.length,
        sql: planned.map((it) => shortSql(it.query))
      });
      for (const statement of planned) {
        await withLockRetry(
          () => queryRunner.query(statement.query, statement.parameters),
          statementTarget(statement.query),
          sleep
        );
        applied++;
      }
    } finally {
      await restoreLockWait();
    }
  } catch (error) {
    emitMetric(
      'SchemaSyncFailed',
      error instanceof SchemaSyncLockedError ? 'locked' : 'error',
      planned[applied] ? statementTarget(planned[applied].query) : 'none'
    );
    if (planned.length) {
      logger.error('[SCHEMA_SYNC_FAILED]', {
        applied: planned.slice(0, applied).map((it) => shortSql(it.query)),
        remaining: planned.slice(applied).map((it) => shortSql(it.query)),
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
  logger.info('[SCHEMA_SYNC_DONE]', { planned: planned.length, applied });
  return { planned: planned.length, applied };
}

async function shortenLockWait(
  queryRunner: QueryRunner
): Promise<() => Promise<void>> {
  const rows: { timeout?: unknown }[] | undefined = await queryRunner.query(
    'select @@session.lock_wait_timeout as timeout'
  );
  const read = Number(rows?.[0]?.timeout);
  const timeout =
    Number.isInteger(read) && read > 0 ? read : MYSQL_DEFAULT_LOCK_WAIT_SECONDS;
  await queryRunner.query('set session lock_wait_timeout = ?', [
    SCHEMA_SYNC_LOCK_WAIT_SECONDS
  ]);
  return async () => {
    try {
      await queryRunner.query('set session lock_wait_timeout = ?', [timeout]);
    } catch (error) {
      logger.warn('[SCHEMA_SYNC_LOCK_WAIT_RESTORE_FAILED]', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

async function withLockRetry<T>(
  run: () => Promise<T>,
  target: string,
  sleep: Sleep
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isLockWaitTimeout(error)) throw error;
      const final = attempt >= SCHEMA_SYNC_ATTEMPTS;
      emitMetric(
        'SchemaSyncLockTimeout',
        final ? 'gave_up' : 'retried',
        target
      );
      logger.warn('[SCHEMA_SYNC_LOCK_TIMEOUT]', {
        table: target,
        attempt,
        of: SCHEMA_SYNC_ATTEMPTS
      });
      if (final)
        throw new SchemaSyncLockedError(
          `Schema change on ${target} stayed locked after ${attempt} attempts of ${SCHEMA_SYNC_LOCK_WAIT_SECONDS}s; not applied`
        );
      await sleep(SCHEMA_SYNC_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
}
