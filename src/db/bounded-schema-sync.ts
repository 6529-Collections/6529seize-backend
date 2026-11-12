import { DataSource, QueryRunner } from 'typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder';
import { Logger } from '@/logging';
import {
  checkSchemaPlan,
  destructivePlanDecision,
  informationSchemaCatalog,
  PlannedSchemaStatement,
  SchemaCatalog,
  SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV,
  SchemaPlanCheck,
  schemaSyncDestructiveGuardMode,
  SchemaSyncDestructiveGuardMode
} from './schema-sync-plan-check';

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
  /** Present when the plan contained destructive statements. */
  readonly destructivePlanSha256?: string;
}

export interface SchemaSyncOptions {
  readonly sleep?: Sleep;
  /**
   * `block` holds back a plan with destructive statements unless
   * `acknowledgedDestructivePlanSha256` matches it; `report` (the default,
   * from SCHEMA_SYNC_DESTRUCTIVE_GUARD) logs such a plan and applies it.
   */
  readonly destructiveGuardMode?: SchemaSyncDestructiveGuardMode;
  /** SHA-256 an operator approved from a previously reported plan. */
  readonly acknowledgedDestructivePlanSha256?: string | null;
  /** Test seam; defaults to information_schema on the sync connection. */
  readonly catalog?: SchemaCatalog;
}

/**
 * The plan contained statements that remove data or relax a unique key and
 * was not acknowledged; nothing from it was applied.
 */
export class SchemaSyncDestructivePlanRefusedError extends Error {
  constructor(
    public readonly destructivePlanSha256: string,
    public readonly destructiveStatements: readonly string[]
  ) {
    super(
      `Schema sync plan has ${destructiveStatements.length} destructive statement(s) and was not applied; to apply it, invoke with approved_destructive_plan_sha256=${destructivePlanSha256}`
    );
    this.name = 'SchemaSyncDestructivePlanRefusedError';
    // Keeps instanceof working for the ES5 build target.
    Object.setPrototypeOf(
      this,
      SchemaSyncDestructivePlanRefusedError.prototype
    );
  }
}

export class SchemaSyncLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaSyncLockedError';
    // Keeps instanceof working for the ES5 build target.
    Object.setPrototypeOf(this, SchemaSyncLockedError.prototype);
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
  name:
    | 'SchemaSyncLockTimeout'
    | 'SchemaSyncFailed'
    | 'SchemaSyncDestructivePlan',
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
 * - Classify the plan (schema-sync-plan-check.ts) before applying any of it.
 *   A plan that drops columns, tables or unique keys is logged in full with
 *   the SHA-256 of its destructive statements. With
 *   SCHEMA_SYNC_DESTRUCTIVE_GUARD=block such a plan is not applied unless the
 *   caller passes that SHA-256 as its acknowledgement; by default it is only
 *   reported.
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
  options: SchemaSyncOptions = {}
): Promise<SchemaSyncResult> {
  // Resolved first: an unrecognised guard setting fails before any work.
  const mode =
    options.destructiveGuardMode ??
    schemaSyncDestructiveGuardMode(
      process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV]
    );
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const builder = dataSource.driver.createSchemaBuilder() as RdbmsSchemaBuilder;
  const queryRunner = dataSource.createQueryRunner('master');
  let applied = 0;
  let planned: { query: string; parameters?: unknown[] }[] = [];
  let destructivePlanSha256: string | null = null;
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
      if (planned.length) {
        destructivePlanSha256 = await guardDestructivePlan(
          planned,
          options.catalog ??
            informationSchemaCatalog((sql, parameters) =>
              queryRunner.query(sql, parameters)
            ),
          mode,
          options.acknowledgedDestructivePlanSha256
        );
      }
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
    if (error instanceof SchemaSyncDestructivePlanRefusedError) throw error;
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
  return destructivePlanSha256
    ? { planned: planned.length, applied, destructivePlanSha256 }
    : { planned: planned.length, applied };
}

/**
 * Classifies the plan before anything is applied. A plan with destructive
 * statements is logged in full with the SHA-256 of its destructive subset;
 * in `block` mode it is refused (nothing applied) unless that SHA-256 was
 * acknowledged. Returns the SHA-256, or null for a plan without them.
 */
async function guardDestructivePlan(
  planned: readonly PlannedSchemaStatement[],
  catalog: SchemaCatalog,
  mode: SchemaSyncDestructiveGuardMode,
  acknowledgedSha256: string | null | undefined
): Promise<string | null> {
  let check: SchemaPlanCheck;
  try {
    check = await checkSchemaPlan(planned, catalog);
  } catch (error) {
    // The check never stops a sync it cannot judge in report mode.
    if (mode === 'block') throw error;
    logger.warn('[SCHEMA_SYNC_PLAN_CHECK_FAILED]', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
  const decision = destructivePlanDecision(check, {
    mode,
    acknowledgedSha256
  });
  if (decision === 'none') return null;
  const sha256 = check.destructivePlanSha256!;
  logger.warn('[SCHEMA_SYNC_DESTRUCTIVE_PLAN]', {
    mode,
    decision,
    destructivePlanSha256: sha256,
    destructive: check.destructive.length,
    plan: check.statements.map((it) => ({
      kind: it.kind,
      reason: it.reason,
      sql: it.query,
      parameters: it.parameters
    }))
  });
  emitMetric(
    'SchemaSyncDestructivePlan',
    decision,
    statementTarget(check.destructive[0].query)
  );
  if (decision === 'refused') {
    throw new SchemaSyncDestructivePlanRefusedError(
      sha256,
      check.destructive.map((it) => it.query)
    );
  }
  return sha256;
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
