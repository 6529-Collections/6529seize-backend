import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Logger } from '@/logging';
import {
  DEFAULT_BULK,
  identityFreezeSettingProblem,
  parseCmsFields,
  parseExtraIds,
  readIdentityFreezeAt
} from '@/identity-export/cli-options';
import { SqlIdentityExportSource } from '@/identity-export/identity-export.db';
import { IdentityExportNotReadyError } from '@/identity-export/identity-export.errors';
import {
  buildIdentityExport,
  IdentityExportDocument
} from '@/identity-export/identity-export.service';
import {
  CmsFieldsFile,
  InputFile
} from '@/identity-export/identity-export.types';
import { jsonDocumentBytes } from '@/identity-export/identity-export.writer';
import {
  noCmsFieldsProblem,
  PROFILE_SITE_CMS_FILE,
  profileSiteManifestProblem
} from '@/identity-export/profile-site-manifest';
import { DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import { buildCommit } from './build-commit';
import {
  FreshSecretValue,
  LAMBDAS_SECRET_ID,
  readFreshSecretValue
} from './chain-exports/fresh-secret';
import {
  assertBucketPrivate,
  BucketPrivacy,
  ExportBucket,
  exportBucketOf,
  exportStage,
  isNetworkError,
  isWriteConflict,
  linksLastAtMost,
  Presigner,
  PRESIGNED_URL_SECONDS,
  PrivateExportWriter,
  PutResult,
  runPrefix,
  s3Presigner
} from './chain-exports/private-export-bucket';
import {
  errorCode,
  isAcceptableUnreadableLag,
  openReadOnlySnapshot,
  ReadOnlyEvidence,
  ReadOnlySnapshot,
  REPLICA_LAG_AGE_MARGIN_MS,
  ReplicaTarget,
  replicaTarget
} from './chain-exports/replica-snapshot';

const logger = Logger.get('IDENTITY_EXPORT_JOB');

const JOB = 'identityExport';
const LINKS_JOB = 'identityExportLinks';
const JOB_PREFIX = 'identity-export';
const PREFIX_ROOT = `${JOB_PREFIX}/`;
/** The profile site export's runs, whose cms-fields.json this job reads. */
const SITE_JOB_PREFIX = 'profile-site-export';
/**
 * Where a rehearsal's input may be read from: this job's own prefix (a
 * waves list put there), or a profile site export run (its cms-fields.json).
 */
const INPUT_ROOTS = [PREFIX_ROOT, `${SITE_JOB_PREFIX}/`] as const;
const EXPORT_FILE = 'identity-export.json';
const SUMMARY_FILE = 'summary.json';
const MANIFEST = 'manifest.json';
/**
 * Not an export the chain's import may use: a rehearsal or timing run, with
 * no freeze to hold the database to.
 */
const UNUSABLE_MANIFEST = 'manifest.unusable.json';
const MANIFEST_SCHEMA = '6529.identity-export.manifest.v1';
const MANIFEST_NAMES = [MANIFEST, UNUSABLE_MANIFEST] as const;
/** An input file read from the bucket is never larger than this. */
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/** The snapshot may be at most this long after the freeze, unless acknowledged. */
export const SNAPSHOT_GAP_LIMIT_MINUTES = 90;
/**
 * A run at the freeze needs its snapshot at least this long after the
 * freeze on the replica's clock, so writes made before the freeze have
 * reached it.
 */
export const MIN_SNAPSHOT_GAP_SECONDS = 120;
/** Below this much time left, the run stops with its progress. */
const DEADLINE_MARGIN_MS = 60_000;

/**
 * A rehearsal's input: an object of the private chain exports bucket
 * (`{ "key": "identity-export/inputs/waves.json" }`), or the content inline
 * (`{ "inline": [...] }`). At the freeze the waves list is given the same
 * way, and the profile site values are found through the profile site
 * export's pointer for that freeze.
 */
export type IdentityExportInput =
  | { readonly key: string }
  | { readonly inline: unknown };

/** Where a hand-run cms-fields.json must be uploaded. */
const HAND_RUN_ROOT = `${PREFIX_ROOT}inputs/`;

/**
 * At the freeze, when the profile site export didn't run: the
 * cms-fields.json and report.json made by hand with the profile site
 * export's CLI, uploaded under identity-export/inputs/, with their sha256.
 * The report ties the file to the freeze. Taken only when no profile site
 * pointer exists for the freeze: a site run's values always win.
 */
export interface CmsFieldsAtFreeze {
  readonly key: string;
  readonly sha256: string;
  readonly reportKey: string;
  readonly reportSha256: string;
}

/**
 * Invoke-only jobs of the dbDumpsDaily function (its schedule sends no
 * `job`):
 * - `identityExport`: the identity export (`6529 run identity:export`) on
 *   the read replica, into the private chain exports bucket under
 *   identity-export/<stage>/, the manifest written last. The event carries
 *   the CLI's options, with the same rules;
 * - `identityExportLinks`: fresh download links for an earlier run, by its
 *   prefix or by the freeze it exported.
 */
export type IdentityExportEvent =
  | {
      readonly job: typeof JOB;
      /** Null for a rehearsal (`noFreeze: true`). */
      readonly freezeMs: number | null;
      readonly expectTdhBlock: number | null;
      /** Null: the commit the function was built from. */
      readonly revision: string | null;
      readonly bulk: number;
      readonly includeDelegations: boolean;
      /** Null with `noExtraIds: true`. */
      readonly extraIds: IdentityExportInput | null;
      /**
       * A rehearsal's profile site values; null with `noCmsFields: true`,
       * and at the freeze, where the profile site export's pointer for the
       * freeze names them.
       */
      readonly cmsFields: IdentityExportInput | null;
      /**
       * At the freeze, a hand-run cms-fields.json, only when the profile
       * site export didn't run (no pointer for the freeze); null otherwise.
       */
      readonly cmsFieldsAtFreeze: CmsFieldsAtFreeze | null;
      readonly acceptOverCredit: number;
      readonly acceptEditsAfterFreeze: number;
      readonly acceptRatingsChangedAfterFreeze: number;
      readonly acceptMissingExtraIds: number;
      readonly acceptProfileWritesAfterFreeze: number;
      readonly acceptUnmatchedCms: number;
      /**
       * At most this many consolidation rows and primary-address delegations
       * after the TDH block (a ceiling: the count can grow while the run
       * waits).
       */
      readonly acceptConsolidationsAfterFreeze: number;
      /** At the freeze without the waves list. */
      readonly acceptNoExtraIds: boolean;
      /**
       * At the freeze, a profile site export with no sites: its
       * cms-fields.json is empty, so no identity carries a cms value.
       */
      readonly acceptNoCmsFields: boolean;
      /** At the freeze with a bulk threshold other than 2000. */
      readonly acceptBulk: number | null;
      /** Accepts a snapshot up to this many minutes after the freeze. */
      readonly acceptSnapshotGapMinutes: number | null;
      /**
       * The untrusted lags the run may go through, by the case names the
       * refusals use (unreadable, dated_ahead, older_than_gap), relying on
       * the minimum gap after the freeze and on any lag the row reports.
       */
      readonly acceptUnknownReplicaLag: readonly ReplicaLagAcceptance[];
      /** Replace the freeze's pointer if a run wrote one already. */
      readonly replacePointer: boolean;
    }
  | {
      readonly job: typeof LINKS_JOB;
      readonly prefix: string | null;
      readonly freezeMs: number | null;
    };

type ExportEvent = Extract<IdentityExportEvent, { job: typeof JOB }>;
type LinksEvent = Extract<IdentityExportEvent, { job: typeof LINKS_JOB }>;

export class IdentityExportEventError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportEventError';
  }
}

/** The snapshot can't stand for the freeze. */
export class IdentityExportSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportSnapshotError';
  }
}

/** The run stopped before the function's time ran out; nothing was written. */
export class IdentityExportDeadlineError extends Error {
  constructor(
    readonly step: string,
    readonly elapsedSeconds: number
  ) {
    super(
      `Stopped after "${step}" at ${elapsedSeconds} s, with less than ${DEADLINE_MARGIN_MS / 1000} s of the function's time left. No manifest was written: the export needs longer than one invocation.`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportDeadlineError';
  }
}

/**
 * Refuses a snapshot taken before the freeze, sooner after it than
 * `minGapSeconds`, or longer after it than the limit (90 minutes) or than
 * the invoker acknowledged.
 */
export function checkSnapshotTime(
  freezeMs: number,
  snapshotAt: number,
  acceptGapMinutes: number | null,
  minGapSeconds = 0
): { readonly gapMs: number; readonly gapSeconds: number } {
  if (!Number.isFinite(snapshotAt)) {
    throw new IdentityExportSnapshotError("The snapshot's time is unknown");
  }
  // Compared in milliseconds: rounding would let a snapshot taken just
  // before the freeze, or just short of the minimum gap, through.
  const gapMs = snapshotAt - freezeMs;
  if (gapMs < 0) {
    throw new IdentityExportSnapshotError(
      `The snapshot (${new Date(snapshotAt).toISOString()}) is before the freeze (${new Date(freezeMs).toISOString()})`
    );
  }
  if (gapMs < minGapSeconds * 1000) {
    throw new IdentityExportSnapshotError(
      `The snapshot is ${gapMs / 1000} s after the freeze: wait until at least ${minGapSeconds} s after it, so the replica holds every write made before the freeze`
    );
  }
  const limit = Math.max(SNAPSHOT_GAP_LIMIT_MINUTES, acceptGapMinutes ?? 0);
  if (gapMs > limit * 60_000) {
    throw new IdentityExportSnapshotError(
      `The snapshot is ${Math.ceil(gapMs / 60_000)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to accept that.`
    );
  }
  return { gapMs, gapSeconds: Math.round(gapMs / 1000) };
}

/** The lags a run can accept by name: each refusal names its own. */
export const REPLICA_LAG_CASES = [
  'unreadable',
  'dated_ahead',
  'older_than_gap'
] as const;

/** Which untrusted lag a run accepted. */
export type ReplicaLagAccepted = (typeof REPLICA_LAG_CASES)[number];

/**
 * One untrusted lag case a run may go through, as the invoker names it.
 * A time zone offset keeps a row's age (or its lead over UTC) constant; a
 * reader that stopped updating makes the age grow (the lead shrink). So
 * older_than_gap carries the largest row age accepted, from Monday's
 * replicaLagAgeMs plus a margin, and dated_ahead the smallest lead, from
 * Monday's replicaLagAheadMs minus a margin: past either, it is refused.
 */
export type ReplicaLagAcceptance =
  | 'unreadable'
  | { readonly dated_ahead: number }
  | { readonly older_than_gap: number };

/** Time zones reach 14 hours from UTC; a bound may add a margin to that. */
const MAX_ZONE_BOUND_MS = 14 * 60 * 60 * 1000 + 10 * 60 * 1000;
/**
 * A smaller lead over UTC is no time zone: none is less than 30 minutes
 * from UTC, and a bound sits a margin under Monday's lead.
 */
const MIN_DATED_AHEAD_BOUND_MS = 1_740_000;
/**
 * The margin a bound is taken with, from Monday's reading: a reader that
 * stalled for up to this long still passes it, so an accepted bounded case
 * counts it as lag.
 */
const ACCEPT_MARGIN_MS = 60_000;

const ACCEPT_FORMS =
  '"unreadable", {"dated_ahead": <smallest lead in ms: Monday\'s replicaLagAheadMs minus 60000>}, or {"older_than_gap": <largest row age in ms: Monday\'s replicaLagAgeMs plus 60000>}';

/** How a refusal says to accept its case. */
function acceptanceExample(lagCase: ReplicaLagAccepted): string {
  if (lagCase === 'older_than_gap') {
    return 'acceptUnknownReplicaLag: {"older_than_gap": <Monday\'s replicaLagAgeMs plus 60000>}';
  }
  if (lagCase === 'dated_ahead') {
    return 'acceptUnknownReplicaLag: {"dated_ahead": <Monday\'s replicaLagAheadMs minus 60000>}';
  }
  return `acceptUnknownReplicaLag: "${lagCase}"`;
}

/** The bound an acceptance gives a case, if it names that case. */
function boundFor(
  accepted: readonly ReplicaLagAcceptance[],
  lagCase: 'dated_ahead' | 'older_than_gap'
): number | undefined {
  for (const it of accepted) {
    if (typeof it === 'object' && lagCase in it) {
      return (it as Record<string, number>)[lagCase];
    }
  }
  return undefined;
}

/** What to do when the lag can't be trusted: the same in every refusal. */
function unknownLagSteps(lagCase: ReplicaLagAccepted, only: string): string {
  return `Run once more first: a passing error, such as a timeout, clears, and through the reader endpoint the run may land on another reader. Accept it (${acceptanceExample(lagCase)}) only for a reading Monday's rehearsal also showed${only}, and only with the switch owner's agreement: the run then relies on the 2-minute minimum gap, and still on the lag the row reports when it has one. Otherwise report it.`;
}

/**
 * Refuses a replica that may be as far behind its writer as the snapshot is
 * after the freeze, or further: it might not yet hold writes made before
 * the freeze. Its lag row can be stale, so the row's age counts too. A lag
 * that can't be read, a row dated ahead of UTC, and a row older than the
 * whole gap are refused unless the invoker accepts that case by name; the
 * case accepted is returned, to be recorded. The lag a row reports is held
 * to the gap in every case: only when there is none does the minimum gap
 * alone decide. A lag that is simply too large is never accepted.
 */
export function checkReplicaLag(
  gapMs: number,
  lag: Pick<
    ReadOnlyEvidence,
    | 'replicaLagMs'
    | 'replicaLagAgeMs'
    | 'replicaLagError'
    | 'replicaLagUnknown'
    | 'replicaLagAheadMs'
  >,
  accepted: readonly ReplicaLagAcceptance[] = []
): ReplicaLagAccepted | null {
  const lagCase = replicaLagCaseOf(gapMs, lag);
  // A reader dated ahead that stopped updating loses its lead as time
  // passes, and once the lead has run out its row reads as fresh: with a
  // dated_ahead bound accepted, any other reading is refused.
  const leadBound = boundFor(accepted, 'dated_ahead');
  if (
    leadBound !== undefined &&
    (lagCase === null || lagCase === 'older_than_gap')
  ) {
    throw new IdentityExportSnapshotError(
      `dated_ahead was accepted down to a ${leadBound} ms lead, but this reader's row reads ${lagCase ?? 'as fresh'}: a reader dated ahead that stopped updating reads that way once its lead has run out. Run once more without changing anything; if it reads the same, report it.`
    );
  }
  // The lag the row reports counts whenever there is one; its age only
  // when the row's timestamp can be trusted, and the age can read up to
  // REPLICA_LAG_AGE_MARGIN_MS low. A bounded case accepted can hide a
  // stall up to the bound's margin: that counts as lag.
  if (lag.replicaLagMs !== null) {
    const ageMs = lagCase === null ? (lag.replicaLagAgeMs ?? 0) : 0;
    const stallMs =
      (lagCase === 'dated_ahead' || lagCase === 'older_than_gap') &&
      boundFor(accepted, lagCase) !== undefined
        ? ACCEPT_MARGIN_MS
        : 0;
    const behindMs = lag.replicaLagMs + ageMs + stallMs;
    if (behindMs + REPLICA_LAG_AGE_MARGIN_MS >= gapMs) {
      const what =
        lagCase === null
          ? `may be ${behindMs} ms behind its writer (a ${lag.replicaLagMs} ms lag in a row ${ageMs} ms old)`
          : `reports a ${lag.replicaLagMs} ms lag (its row's age not counted: ${lagCase}${stallMs ? `; ${stallMs} ms more for a stall within the bound's margin` : ''})`;
      // A trusted row's lag falls as the reader catches up; an untrusted
      // (stale) row's lag never changes, so waiting won't help.
      const next =
        lagCase === null
          ? 'Wait a few minutes and run again.'
          : "The row can't be trusted, and a stale row's lag never changes: run once more, and if this refusal comes back unchanged, report it.";
      throw new IdentityExportSnapshotError(
        `The replica ${what}, which with ${REPLICA_LAG_AGE_MARGIN_MS} ms for the row's timestamp is not less than the ${gapMs} ms since the freeze: it may not hold every write made before the freeze. ${next}`
      );
    }
  }
  if (lagCase === null) return null;
  if (lagCase === 'older_than_gap') {
    const bound = boundFor(accepted, lagCase);
    if (bound !== undefined) {
      if ((lag.replicaLagAgeMs ?? Infinity) <= bound) return lagCase;
      throw new IdentityExportSnapshotError(
        `The replica's lag row is ${lag.replicaLagAgeMs} ms old, over the ${bound} ms accepted for older_than_gap: it has aged past Monday's reading, so the reader may have stopped updating its row. Report it; don't raise the bound.`
      );
    }
  } else if (lagCase === 'dated_ahead') {
    const bound = boundFor(accepted, lagCase);
    if (bound !== undefined) {
      if ((lag.replicaLagAheadMs ?? -Infinity) >= bound) return lagCase;
      throw new IdentityExportSnapshotError(
        `The replica's lag row is dated ${lag.replicaLagAheadMs} ms ahead of UTC, less than the ${bound} ms accepted for dated_ahead: its lead has shrunk since Monday's reading, so the reader may have stopped updating its row. Report it; don't lower the bound.`
      );
    }
  } else if (accepted.includes(lagCase)) {
    // lagCase is 'unreadable': only the "can't read the lag on this
    // server" cases. A timeout or a refusal can come from a reader falling
    // behind.
    if (isAcceptableUnreadableLag(lag.replicaLagError)) return lagCase;
    throw new IdentityExportSnapshotError(
      `unreadable was accepted, but this reading's reason (${lag.replicaLagError ?? 'no reason given'}) isn't one it covers: only ER_UNKNOWN_TABLE 1109 or ER_UNKNOWN_SYSTEM_VARIABLE 1193 (the reader isn't Aurora), no row for this server, a null lag or a null timestamp. A timeout or a refusal can come from a reader falling behind: run once more, and if it returns, report it.`
    );
  }
  const reason = lag.replicaLagError ?? 'no reason given';
  if (lagCase === 'dated_ahead') {
    throw new IdentityExportSnapshotError(
      `The replica's lag row is dated ahead of UTC (${reason}): LAST_UPDATE_TIMESTAMP may not be in UTC, so the row's age is unknown. ${unknownLagSteps(lagCase, '')}`
    );
  }
  if (lagCase === 'older_than_gap') {
    throw new IdentityExportSnapshotError(
      `The replica's lag row is ${lag.replicaLagAgeMs} ms old (a ${lag.replicaLagMs} ms lag), older than the ${gapMs} ms since the freeze: LAST_UPDATE_TIMESTAMP may not be in UTC, or the reader stopped updating its row. If the same refusal returns with the row's age grown by the time you waited, the reader stopped updating: report it. ${unknownLagSteps(lagCase, '')}`
    );
  }
  throw new IdentityExportSnapshotError(
    `The replica's lag can't be read from information_schema.replica_host_status (${reason}). ${unknownLagSteps(lagCase, ": for an error, only ER_UNKNOWN_TABLE 1109 or ER_UNKNOWN_SYSTEM_VARIABLE 1193 (the reader isn't Aurora)")}`
  );
}

/**
 * The untrusted lag case a run would refuse on unless accepted by name, or
 * null when the lag and its row's age can be trusted (the lag may still be
 * too large for the gap).
 */
export function replicaLagCaseOf(
  gapMs: number,
  lag: Pick<
    ReadOnlyEvidence,
    'replicaLagMs' | 'replicaLagAgeMs' | 'replicaLagUnknown'
  >
): ReplicaLagAccepted | null {
  if (
    lag.replicaLagUnknown !== null ||
    lag.replicaLagMs === null ||
    lag.replicaLagAgeMs === null
  ) {
    return lag.replicaLagUnknown ?? 'unreadable';
  }
  return lag.replicaLagAgeMs >= gapMs ? 'older_than_gap' : null;
}

/** The read replica failed; its message stays in the function's log. */
export class IdentityExportDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportDatabaseError';
  }
}

/** A network call failed; its message stays in the function's log. */
export class IdentityExportNetworkError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportNetworkError';
  }
}

/** The MySQL driver's codes: ER_..., PROTOCOL_..., HANDSHAKE_..., POOL_... */
const MYSQL_ERROR_CODE = /^(ER|PROTOCOL|HANDSHAKE|POOL)_[A-Z0-9_]+$/;

interface ErrorFields {
  readonly code?: unknown;
  readonly sqlMessage?: unknown;
  readonly fatal?: unknown;
  readonly syscall?: unknown;
  readonly hostname?: unknown;
}

/** A DNS lookup's failure: EAI_AGAIN, ENOTFOUND, a getaddrinfo call. */
function isDnsFailure(error: unknown): boolean {
  const { code, syscall } = (error ?? {}) as ErrorFields;
  return (
    syscall === 'getaddrinfo' ||
    (typeof code === 'string' &&
      (/^EAI_[A-Z0-9_]+$/.test(code) ||
        ['ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(code)))
  );
}

/**
 * What the operator is told of a database or network failure: for a DNS
 * failure, that the lookup failed and to retry; otherwise what failed. The
 * code and number always; never the host.
 */
function failureMessage(what: string, during: string, error: unknown): string {
  return isDnsFailure(error)
    ? `DNS lookup failed, retry: ${errorCode(error)} (${what}, while ${during}). The host it looked up is in the function's log.`
    : `${what} failed while ${during}: ${errorCode(error)}. Its message, which can name the host or user, is in the function's log.`;
}

/**
 * An error from the database connection or a query on it, as its code and
 * number only: its message can name the user and host ('user'@'host') or
 * the hostname (getaddrinfo EAI_AGAIN <host>), and the response goes to
 * the operator's out.json. The message goes to the log. Called only where
 * the database raised the error; the export's own refusals, and anything
 * else, are returned as they are.
 */
export function databaseErrorOf(error: unknown, during: string): unknown {
  const { code, sqlMessage, fatal } = (error ?? {}) as ErrorFields;
  if (
    sqlMessage === undefined &&
    fatal !== true &&
    !isNetworkError(error) &&
    !(typeof code === 'string' && MYSQL_ERROR_CODE.test(code))
  ) {
    return error;
  }
  logger.error(
    `[READ REPLICA FAILED] [${during}] ${String((error as Error)?.message ?? error)}`
  );
  return new IdentityExportDatabaseError(
    failureMessage('The read replica', during, error)
  );
}

/**
 * Any other network failure (an S3 call, the secret's read), as its code
 * and number only, with its own wording: its message can name the host.
 * Anything else is returned as it is.
 */
export function networkErrorOf(error: unknown, during: string): unknown {
  if (error instanceof IdentityExportDatabaseError || !isNetworkError(error)) {
    return error;
  }
  logger.error(
    `[NETWORK CALL FAILED] [${during}] ${String((error as Error)?.message ?? error)}`
  );
  return new IdentityExportNetworkError(
    failureMessage('A network call', during, error)
  );
}

/** An AWS service refused; its message stays in the function's log. */
export class IdentityExportServiceError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportServiceError';
  }
}

/**
 * An error as words the operator may see: a network error's code and
 * number, an AWS service error's name and HTTP status, or the error's
 * name; never its message.
 */
export function errorName(error: unknown): string {
  if (isNetworkError(error)) return errorCode(error);
  const { name, $metadata } = (error ?? {}) as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = $metadata?.httpStatusCode;
  return `${typeof name === 'string' ? name : 'Error'}${status === undefined ? '' : ` (${status})`}`;
}

/**
 * An AWS service's refusal (S3, Secrets Manager) as its name and HTTP
 * status, never its message. Anything else is returned as it is.
 */
export function serviceErrorOf(error: unknown, during: string): unknown {
  const { name, $metadata } = (error ?? {}) as {
    name?: unknown;
    $metadata?: unknown;
  };
  if ($metadata === undefined || typeof name !== 'string') return error;
  const status = ($metadata as { httpStatusCode?: unknown })?.httpStatusCode;
  // No HTTP status: the call never got an answer (a timeout, a certificate):
  // a network failure, not a refusal.
  if (typeof status !== 'number') {
    logger.error(
      `[NETWORK CALL FAILED] [${during}] ${String((error as Error)?.message ?? error)}`
    );
    return new IdentityExportNetworkError(
      `A network call failed while ${during}: ${name}. Its message, which can name the host, is in the function's log.`
    );
  }
  logger.error(
    `[AWS CALL REFUSED] [${during}] ${String((error as Error)?.message ?? error)}`
  );
  return new IdentityExportServiceError(
    `An AWS call was refused while ${during}: ${errorName(error)}. Its message is in the function's log.`
  );
}

/**
 * The snapshot's executor, its errors given as codes: every query of the
 * read goes through it, so only errors the database raised are read as
 * the replica's.
 */
class ReplicaErrorsExecutor extends SqlExecutor {
  constructor(private readonly inner: SqlExecutor) {
    super();
  }

  async execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    try {
      return await this.inner.execute<T>(sql, params, options);
    } catch (error) {
      throw databaseErrorOf(error, 'reading the snapshot');
    }
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.inner.executeNativeQueriesInTransaction(executable, options);
  }
}

/**
 * acceptUnknownReplicaLag as given: one case or a list, each named as the
 * refusals name it, older_than_gap with its largest row age.
 */
export function acceptedLagCasesOf(value: unknown): ReplicaLagAcceptance[] {
  if (value === undefined || value === false) return [];
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const refuse = () =>
    new IdentityExportEventError(
      `acceptUnknownReplicaLag must name each case to accept, as the refusals do: ${ACCEPT_FORMS}; one or a list, each once. A bound on a row's age is ${MIN_SNAPSHOT_GAP_SECONDS * 1000} to ${MAX_ZONE_BOUND_MS} ms, on its lead ${MIN_DATED_AHEAD_BOUND_MS} to ${MAX_ZONE_BOUND_MS} ms. true and a bare "dated_ahead" or "older_than_gap" are not accepted: a rerun that lands on another reader showing another case, or a reader that stopped, must be refused.`
    );
  const seen = new Set<string>();
  return list.map((item) => {
    let name: string;
    let acceptance: ReplicaLagAcceptance;
    const keys =
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? Object.keys(item)
        : [];
    const bound =
      keys.length === 1 ? (item as Record<string, unknown>)[keys[0]] : null;
    const within = (min: number) =>
      Number.isSafeInteger(bound) &&
      (bound as number) >= min &&
      (bound as number) <= MAX_ZONE_BOUND_MS;
    if (item === 'unreadable') {
      name = item;
      acceptance = item;
    } else if (
      keys[0] === 'older_than_gap' &&
      within(MIN_SNAPSHOT_GAP_SECONDS * 1000)
    ) {
      name = 'older_than_gap';
      acceptance = { older_than_gap: bound as number };
    } else if (keys[0] === 'dated_ahead' && within(MIN_DATED_AHEAD_BOUND_MS)) {
      name = 'dated_ahead';
      acceptance = { dated_ahead: bound as number };
    } else {
      throw refuse();
    }
    if (seen.has(name)) throw refuse();
    seen.add(name);
    return acceptance;
  });
}

/** IDENTITY_FREEZE_AT as 6529.io's profile site reads it. */
export interface FreezeSetting {
  readonly reading: 'unset' | 'not_a_time' | 'time';
  readonly at: string | null;
}

export function readFreezeSetting(raw: string | undefined): FreezeSetting {
  const parsed = readIdentityFreezeAt(raw);
  if (parsed === undefined) return { reading: 'unset', at: null };
  if (parsed === null || Math.abs(parsed) > 8.64e15) {
    return { reading: 'not_a_time', at: null };
  }
  return { reading: 'time', at: new Date(parsed).toISOString() };
}

/**
 * Why the secret's IDENTITY_FREEZE_AT doesn't name this freeze, or null:
 * as the CLI's check, naming the secret read.
 */
export function freezeSecretProblem(
  freezeMs: number,
  secret: FreshSecretValue
): string | null {
  const problem = identityFreezeSettingProblem(freezeMs, secret.value);
  return problem === null
    ? null
    : `${problem} (read from the ${secret.secretId} secret of this region at the start of the run; a warm container's environment is not used)`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const EXPORT_FIELDS = [
  'job',
  'freezeAt',
  'noFreeze',
  'expectTdhBlock',
  'revision',
  'bulk',
  'noDelegations',
  'extraIds',
  'noExtraIds',
  'cmsFields',
  'noCmsFields',
  'cmsFieldsAtFreeze',
  'acceptOverCredit',
  'acceptEditsAfterFreeze',
  'acceptRatingsChangedAfterFreeze',
  'acceptMissingExtraIds',
  'acceptProfileWritesAfterFreeze',
  'acceptUnmatchedCms',
  'acceptConsolidationsAfterFreeze',
  'acceptNoExtraIds',
  'acceptNoCmsFields',
  'acceptBulk',
  'acceptSnapshotGapMinutes',
  'acceptUnknownReplicaLag',
  'replacePointer'
] as const;

function freezeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    if (value >= 1e12 && value < 1e13) return value;
  }
  if (typeof value === 'string' && ISO_UTC.test(value)) {
    const millis = Date.parse(value);
    if (
      Number.isFinite(millis) &&
      new Date(millis).toISOString().slice(0, 10) === value.slice(0, 10)
    ) {
      return millis;
    }
  }
  throw new IdentityExportEventError(
    'freezeAt must be an ISO UTC time (2026-11-24T00:00:00Z) or 13-digit Unix milliseconds'
  );
}

function midnightOf(value: unknown): number {
  const freezeMs = freezeOf(value);
  if (freezeMs % 86_400_000 !== 0) {
    throw new IdentityExportEventError(
      `freezeAt must be 00:00 UTC, got ${new Date(freezeMs).toISOString()}`
    );
  }
  return freezeMs;
}

function wholeNumber(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IdentityExportEventError(`${name} must be a whole number`);
  }
  return value;
}

function flag(name: string, value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new IdentityExportEventError(`${name} must be true when given`);
}

function only(record: Record<string, unknown>, allowed: readonly string[]) {
  const unknownFields = Object.keys(record).filter(
    (key) => !allowed.includes(key)
  );
  if (unknownFields.length) {
    throw new IdentityExportEventError(
      `Unknown fields: ${unknownFields.join(', ')}`
    );
  }
}

/** A run's prefix under `root`, as runPrefix writes it. */
function runPrefixOf(value: unknown, root: string, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(root) ||
    !value.endsWith('/') ||
    value.includes('..') ||
    value.includes('/by-freeze/') ||
    !/^[A-Za-z0-9/_.-]+$/.test(value)
  ) {
    throw new IdentityExportEventError(
      `${name} must be a run's prefix under ${root}, ending in /`
    );
  }
  return value;
}

/** An input given as `{ key }` in the bucket or `{ inline }`. */
function inputOf(name: string, value: unknown): IdentityExportInput {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const keys = record ? Object.keys(record) : [];
  if (record && keys.length === 1 && keys[0] === 'key') {
    const key = record.key;
    if (
      typeof key !== 'string' ||
      !INPUT_ROOTS.some((root) => key.startsWith(root)) ||
      key.endsWith('/') ||
      key.includes('..') ||
      !/^[A-Za-z0-9/_.-]+$/.test(key)
    ) {
      throw new IdentityExportEventError(
        `${name}.key must name an object under ${INPUT_ROOTS.join(' or ')} in the chain exports bucket`
      );
    }
    return { key };
  }
  if (record && keys.length === 1 && keys[0] === 'inline') {
    return { inline: record.inline };
  }
  throw new IdentityExportEventError(
    `${name} must be { "key": "<object key>" } or { "inline": <content> }`
  );
}

/** cmsFieldsAtFreeze as given: an inputs key and the file's sha256. */
function handRunOf(value: unknown): CmsFieldsAtFreeze {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const keys = record ? Object.keys(record).sort() : [];
  const isKey = (key: unknown): key is string =>
    typeof key === 'string' &&
    key.startsWith(HAND_RUN_ROOT) &&
    !key.endsWith('/') &&
    !key.includes('..') &&
    /^[A-Za-z0-9/_.-]+$/.test(key);
  const isSha256 = (hex: unknown): hex is string =>
    typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex);
  const { key, sha256: hex, reportKey, reportSha256 } = record ?? {};
  if (
    keys.join(',') !== 'key,reportKey,reportSha256,sha256' ||
    !isKey(key) ||
    !isKey(reportKey) ||
    key === reportKey ||
    !isSha256(hex) ||
    !isSha256(reportSha256)
  ) {
    throw new IdentityExportEventError(
      `cmsFieldsAtFreeze must be {"key": "${HAND_RUN_ROOT}<cms-fields file>.json", "sha256": "<its 64-hex sha256>", "reportKey": "${HAND_RUN_ROOT}<report file>.json", "reportSha256": "<its 64-hex sha256>"}: the hand-run cms-fields.json and report.json uploaded to the chain exports bucket`
    );
  }
  return {
    key,
    sha256: hex.toLowerCase(),
    reportKey,
    reportSha256: reportSha256.toLowerCase()
  };
}

/** One of the two, as the CLI's `--x FILE` or `--no-x`. */
function oneOf(
  record: Record<string, unknown>,
  field: 'extraIds' | 'cmsFields',
  noField: 'noExtraIds' | 'noCmsFields'
): IdentityExportInput | null {
  const given = record[field] !== undefined;
  const none = flag(noField, record[noField]);
  if (given === none) {
    throw new IdentityExportEventError(
      `Give ${field} or ${noField}: true, one of the two`
    );
  }
  return given ? inputOf(field, record[field]) : null;
}

/** The links job: a run by its prefix, or by the freeze its pointer names. */
function parseLinksEvent(record: Record<string, unknown>): LinksEvent {
  only(record, ['job', 'prefix', 'freezeAt']);
  const hasPrefix = record.prefix !== undefined;
  const hasFreeze = record.freezeAt !== undefined;
  if (hasPrefix === hasFreeze) {
    throw new IdentityExportEventError(
      'Give either prefix (a run) or freezeAt (the run its pointer names)'
    );
  }
  return {
    job: LINKS_JOB,
    prefix: hasPrefix
      ? runPrefixOf(record.prefix, PREFIX_ROOT, 'prefix')
      : null,
    freezeMs: hasFreeze ? midnightOf(record.freezeAt) : null
  };
}

/**
 * What an export at the freeze must take: the profile site values from the
 * site's pointer, the delegations, the waves list unless acknowledged, and
 * the default bulk threshold unless acknowledged.
 */
function checkAtFreeze(record: Record<string, unknown>, bulk: number): void {
  if (record.cmsFields !== undefined || record.noCmsFields !== undefined) {
    throw new IdentityExportEventError(
      "At the freeze the profile site values come from the profile site export's pointer for that freeze, or, only if that export didn't run, from cmsFieldsAtFreeze: leave cmsFields and noCmsFields out"
    );
  }
  if (record.noDelegations !== undefined) {
    throw new IdentityExportEventError(
      'noDelegations is for a rehearsal: an export at the freeze carries the delegations'
    );
  }
  const noExtraIds = flag('noExtraIds', record.noExtraIds);
  const acceptNoExtraIds = flag('acceptNoExtraIds', record.acceptNoExtraIds);
  if (noExtraIds !== acceptNoExtraIds) {
    throw new IdentityExportEventError(
      noExtraIds
        ? 'noExtraIds at the freeze leaves out the profiles in scope only for waves activity: acknowledge it with acceptNoExtraIds: true'
        : 'acceptNoExtraIds is only with noExtraIds'
    );
  }
  const acceptBulk = record.acceptBulk;
  if (bulk === DEFAULT_BULK && acceptBulk !== undefined) {
    throw new IdentityExportEventError(
      `acceptBulk does not match: bulk is the default ${DEFAULT_BULK}; leave acceptBulk out`
    );
  }
  if (bulk !== DEFAULT_BULK && acceptBulk !== bulk) {
    throw new IdentityExportEventError(
      `bulk ${bulk} at the freeze is not the default ${DEFAULT_BULK}: acknowledge it with acceptBulk: ${bulk}`
    );
  }
}

/**
 * This module's job for an invocation's event, null when the event isn't
 * one of its jobs. A job it can't read throws: a typo never falls back to
 * the daily dump or runs with a default.
 */
export function parseIdentityExportEvent(
  event: unknown
): IdentityExportEvent | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record.job === LINKS_JOB) {
    return parseLinksEvent(record);
  }
  if (record.job !== JOB) return null;
  only(record, EXPORT_FIELDS);
  const noFreeze = flag('noFreeze', record.noFreeze);
  if ((record.freezeAt === undefined) === !noFreeze) {
    throw new IdentityExportEventError(
      'Give freezeAt or noFreeze: true for a rehearsal, one of the two'
    );
  }
  const freezeMs = noFreeze ? null : midnightOf(record.freezeAt);
  const expectTdhBlock =
    record.expectTdhBlock === undefined
      ? null
      : wholeNumber('expectTdhBlock', record.expectTdhBlock, 0);
  if (freezeMs !== null && expectTdhBlock === null) {
    throw new IdentityExportEventError(
      "An export at the freeze needs expectTdhBlock, the freeze day's TDH block"
    );
  }
  const gap = record.acceptSnapshotGapMinutes ?? null;
  if (
    gap !== null &&
    (typeof gap !== 'number' ||
      !Number.isSafeInteger(gap) ||
      gap < 0 ||
      gap > 7 * 24 * 60)
  ) {
    throw new IdentityExportEventError(
      'acceptSnapshotGapMinutes must be a whole number of minutes'
    );
  }
  const cmsFieldsAtFreeze =
    record.cmsFieldsAtFreeze === undefined
      ? null
      : handRunOf(record.cmsFieldsAtFreeze);
  if (cmsFieldsAtFreeze !== null && freezeMs === null) {
    throw new IdentityExportEventError(
      "cmsFieldsAtFreeze is for an export at the freeze whose profile site export didn't run: a rehearsal takes cmsFields or noCmsFields"
    );
  }
  if (gap !== null && freezeMs === null) {
    throw new IdentityExportEventError(
      'acceptSnapshotGapMinutes is for an export at the freeze'
    );
  }
  const replacePointer = flag('replacePointer', record.replacePointer);
  if (replacePointer && freezeMs === null) {
    throw new IdentityExportEventError(
      'replacePointer is for an export at the freeze: a rehearsal writes no pointer'
    );
  }
  const accepts = EXPORT_FIELDS.filter(
    (field) => field.startsWith('accept') && record[field] !== undefined
  ).filter((field) => field !== 'acceptSnapshotGapMinutes');
  if (accepts.length && expectTdhBlock === null) {
    throw new IdentityExportEventError(
      `${accepts.join(', ')}: an acknowledgement is only for an export at the freeze, with expectTdhBlock`
    );
  }
  const revision = record.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision))
  ) {
    throw new IdentityExportEventError(
      "revision must be the exporter's 40-hex git commit"
    );
  }
  const bulk = wholeNumber('bulk', record.bulk, DEFAULT_BULK);
  const extraIds = oneOf(record, 'extraIds', 'noExtraIds');
  if (freezeMs !== null) {
    checkAtFreeze(record, bulk);
  }
  const acceptBulk =
    record.acceptBulk === undefined
      ? null
      : wholeNumber('acceptBulk', record.acceptBulk, 0);
  return {
    job: JOB,
    freezeMs,
    expectTdhBlock,
    revision: typeof revision === 'string' ? revision.toLowerCase() : null,
    bulk,
    includeDelegations: !flag('noDelegations', record.noDelegations),
    extraIds,
    cmsFields:
      freezeMs === null ? oneOf(record, 'cmsFields', 'noCmsFields') : null,
    cmsFieldsAtFreeze,
    acceptOverCredit: wholeNumber(
      'acceptOverCredit',
      record.acceptOverCredit,
      0
    ),
    acceptEditsAfterFreeze: wholeNumber(
      'acceptEditsAfterFreeze',
      record.acceptEditsAfterFreeze,
      0
    ),
    acceptRatingsChangedAfterFreeze: wholeNumber(
      'acceptRatingsChangedAfterFreeze',
      record.acceptRatingsChangedAfterFreeze,
      0
    ),
    acceptMissingExtraIds: wholeNumber(
      'acceptMissingExtraIds',
      record.acceptMissingExtraIds,
      0
    ),
    acceptProfileWritesAfterFreeze: wholeNumber(
      'acceptProfileWritesAfterFreeze',
      record.acceptProfileWritesAfterFreeze,
      0
    ),
    acceptUnmatchedCms: wholeNumber(
      'acceptUnmatchedCms',
      record.acceptUnmatchedCms,
      0
    ),
    acceptConsolidationsAfterFreeze: wholeNumber(
      'acceptConsolidationsAfterFreeze',
      record.acceptConsolidationsAfterFreeze,
      0
    ),
    acceptNoExtraIds: flag('acceptNoExtraIds', record.acceptNoExtraIds),
    acceptNoCmsFields: flag('acceptNoCmsFields', record.acceptNoCmsFields),
    acceptBulk,
    acceptSnapshotGapMinutes: gap,
    acceptUnknownReplicaLag: acceptedLagCasesOf(record.acceptUnknownReplicaLag),
    replacePointer
  };
}

/** What a run was asked to export, as its manifest records it. */
export interface IdentityExportScope {
  readonly freezeAt: string | null;
  readonly expectTdhBlock: number | null;
  readonly bulk: number;
  readonly includeDelegations: boolean;
  /** The waves list's bucket key, `inline`, or null (noExtraIds). */
  readonly extraIds: string | null;
  /**
   * The profile site values' bucket key (at the freeze, the cms-fields.json
   * of the run the site's pointer names), `inline`, or null (noCmsFields).
   */
  readonly cmsFields: string | null;
  readonly replacePointer: boolean;
}

/**
 * Where an export at the freeze took its profile site values: the profile
 * site run its pointer names (`site_run`), or, only when there was no
 * pointer for the freeze, a hand-run cms-fields.json (`hand_run`).
 */
export type CmsFieldsSource =
  | {
      readonly kind: 'site_run';
      /** profile-site-export/<stage>/by-freeze/<freeze>.json */
      readonly pointer: string;
      readonly prefix: string;
      readonly manifest: string;
      readonly manifestSha256: string;
      readonly file: string;
      readonly sha256: string;
    }
  | {
      readonly kind: 'hand_run';
      /** identity-export/inputs/<file>.json */
      readonly key: string;
      readonly sha256: string;
      /** The CLI's report.json for the file, and the freeze it records. */
      readonly reportKey: string;
      readonly reportSha256: string;
      readonly reportFrozenAt: string;
      /** The site pointer that wasn't there, and how its read answered. */
      readonly sitePointer: string;
      readonly sitePointerRead: 'missing' | 'forbidden';
    };

export interface IdentityExportResult {
  readonly job: typeof JOB;
  readonly bucket: string;
  /** prod or staging, from NODE_ENV (production, development). */
  readonly stage: string;
  readonly prefix: string;
  /** manifest.json, or manifest.unusable.json when `usable` is false. */
  readonly manifestKey: string;
  /** The manifest's sha256, as stored. */
  readonly manifestSha256: string;
  /** by-freeze/<freezeAt>.json, pointing at this run; only for manifest.json. */
  readonly pointerKey: string | null;
  /** Why the pointer couldn't be written, when it couldn't. */
  readonly pointerError: string | null;
  /** The pointer this run replaced (replacePointer), as it read it. */
  readonly replacedPointer: Record<string, unknown> | null;
  readonly exportKey: string;
  readonly scope: IdentityExportScope;
  /** At the freeze: the profile site run its pointer named. */
  readonly cmsFieldsSource: CmsFieldsSource | null;
  /** The exporter revision written in the file. */
  readonly revision: string;
  /** The commit the function was built from; null when the build can't tell. */
  readonly buildCommit: string | null;
  /** Objects written, the manifest and the links file included. */
  readonly files: number;
  readonly bytes: number;
  readonly identities: number;
  readonly ratings: number;
  readonly tdhBlock: number | null;
  /**
   * True only for an export at the freeze, all its checks passed (one
   * refused writes nothing and throws); a rehearsal is not for the import.
   */
  readonly usable: boolean;
  /**
   * The endpoint the export read: always the reader (DB_HOST_READ, not
   * DB_HOST). The hostname is only in the function's log.
   */
  readonly endpoint: 'reader';
  /** The export read in one READ ONLY transaction with a consistent snapshot. */
  readonly readOnly: true;
  readonly evidence: ReadOnlyEvidence;
  readonly bucketPrivacy: BucketPrivacy;
  /** The freeze time, null for a rehearsal. */
  readonly frozenAt: string | null;
  /** The server's clock when the snapshot was taken. */
  readonly snapshotAt: string;
  /** Seconds from the freeze to the snapshot, rounded; null for a rehearsal. */
  readonly snapshotGapSeconds: number | null;
  /** Milliseconds from the freeze to the snapshot, as checked. */
  readonly snapshotGapMs: number | null;
  /** The untrusted lag cases the run was allowed to go through. */
  readonly acceptUnknownReplicaLag: readonly ReplicaLagAcceptance[];
  /** The unknown or stale lag the run accepted, or null if none. */
  readonly replicaLagAccepted: ReplicaLagAccepted | null;
  /**
   * The untrusted lag case the snapshot showed (unreadable, dated_ahead,
   * older_than_gap), or null when lag and age could be trusted. A
   * rehearsal records it too, against the 2-minute minimum gap alone, a
   * run at the freeze against its own gap: Tuesday may accept only a case
   * Monday showed.
   */
  readonly replicaLagCase: ReplicaLagAccepted | null;
  /** Whether the run was allowed to replace an earlier run's pointer. */
  readonly replacePointer: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
  /** The secret IDENTITY_FREEZE_AT was read from, at the start of the run. */
  readonly identityFreezeAtSecret: string;
  /** IDENTITY_FREEZE_AT as the site reads it: unset, not_a_time or time. */
  readonly identityFreezeAtReading: FreezeSetting['reading'];
  readonly identityFreezeAt: string | null;
  /** The latest the links last (they end sooner with the signing session). */
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  /** links.json: a presigned link for every object of the run. */
  readonly presignedLinksUrl: string;
  /** The pointer this run wrote, to keep with the export; null without one. */
  readonly presignedPointerUrl: string | null;
}

export interface IdentityExportLinksResult {
  readonly job: typeof LINKS_JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly manifestSha256: string;
  /** The pointer the run was found by, when asked by freezeAt. */
  readonly pointerKey: string | null;
  readonly linksKey: string;
  readonly usable: boolean;
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  readonly presignedLinksUrl: string;
  readonly presignedPointerUrl: string | null;
}

export interface IdentityExportContext {
  readonly invokedFunctionArn?: string;
  readonly awsRequestId?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

export interface IdentityExportDeps {
  readonly prepareEnvironment: () => Promise<void>;
  readonly env: () => Readonly<Record<string, string | undefined>>;
  readonly s3: Pick<S3Client, 'send'>;
  readonly presign: Presigner;
  readonly openSnapshot: (target: ReplicaTarget) => Promise<ReadOnlySnapshot>;
  readonly now: () => Date;
  /**
   * IDENTITY_FREEZE_AT read from the lambdas secret now: the environment a
   * warm container loaded at its start would miss a fix to the secret.
   */
  readonly identityFreezeAt: () => Promise<FreshSecretValue>;
  /** The commit the function was built from, or null. */
  readonly buildCommit?: () => string | null;
}

interface ManifestFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface Manifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly files: readonly ManifestFile[];
  readonly [key: string]: unknown;
}

function defaultDeps(): IdentityExportDeps {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  return {
    prepareEnvironment: async () => {
      const { prepEnvironment } = await import('@/env');
      await prepEnvironment();
    },
    env: () => process.env,
    identityFreezeAt: () =>
      readFreshSecretValue(
        new SecretsManagerClient({ region: process.env.AWS_REGION }),
        'IDENTITY_FREEZE_AT'
      ),
    s3,
    presign: s3Presigner(s3),
    openSnapshot: (target) => openReadOnlySnapshot(target),
    now: () => new Date(),
    buildCommit
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The pointer from a freeze to the run that exported it, of a job. */
function pointerKeyOf(job: string, stage: string, freezeMs: number): string {
  return `${job}/${stage}/by-freeze/${new Date(freezeMs)
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
}

function parseJson(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdentityExportEventError(`${what} is not JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityExportEventError(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** An object of the bucket, as its owner's, at most 16 MiB. */
async function objectBytes(
  key: string,
  bucket: ExportBucket,
  s3: Pick<S3Client, 'send'>
): Promise<Buffer> {
  const answer: any = await s3.send(
    new GetObjectCommand({
      Bucket: bucket.name,
      ExpectedBucketOwner: bucket.owner,
      Key: key
    })
  );
  const bytes = Buffer.from(await answer.Body.transformToByteArray());
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new IdentityExportEventError(
      `${key} is ${bytes.length} bytes: more than ${MAX_INPUT_BYTES}`
    );
  }
  return bytes;
}

/** An input's bytes: the bucket object's, or the inline content as JSON. */
async function inputBytes(
  input: IdentityExportInput,
  bucket: ExportBucket,
  s3: Pick<S3Client, 'send'>
): Promise<Buffer> {
  if ('inline' in input) {
    return Buffer.from(JSON.stringify(input.inline), 'utf8');
  }
  return await objectBytes(input.key, bucket, s3);
}

/**
 * At the freeze, the profile site values are those of the run the profile
 * site export's pointer for that freeze names: a whole, usable run of that
 * freeze and stage, whose manifest has the sha256 the pointer records and
 * lists cms-fields.json with the sha256 of the file read.
 */
async function cmsFieldsAtFreeze(
  writer: PrivateExportWriter,
  s3: Pick<S3Client, 'send'>,
  stage: string,
  freezeMs: number,
  handRun: CmsFieldsAtFreeze | null
): Promise<{ bytes: Buffer; source: CmsFieldsSource }> {
  const freeze = new Date(freezeMs).toISOString();
  const pointerKey = pointerKeyOf(SITE_JOB_PREFIX, stage, freezeMs);
  const pointerRead = await writer.readOutside(pointerKey);
  if (handRun !== null) {
    // A site run's values always win: a hand-run file is only for a
    // freeze the profile site export didn't run.
    if (pointerRead.found) {
      throw new IdentityExportEventError(
        `The profile site export ran for the freeze ${freeze}: ${pointerKey} names its run, and its values are the ones taken. Leave cmsFieldsAtFreeze out: a hand-run file never overrides them.`
      );
    }
    const bytes = await handRunBytes(
      handRun.key,
      'cms-fields.json',
      writer.bucket,
      s3
    );
    const fileSha256 = sha256(bytes);
    if (fileSha256 !== handRun.sha256) {
      throw new IdentityExportEventError(
        `${handRun.key} has the sha256 ${fileSha256}, not the ${handRun.sha256} given in cmsFieldsAtFreeze: upload the file that was made, and give its sha256`
      );
    }
    const reportBytes = await handRunBytes(
      handRun.reportKey,
      'report.json',
      writer.bucket,
      s3
    );
    const reportSha256 = sha256(reportBytes);
    if (reportSha256 !== handRun.reportSha256) {
      throw new IdentityExportEventError(
        `${handRun.reportKey} has the sha256 ${reportSha256}, not the ${handRun.reportSha256} given in cmsFieldsAtFreeze: upload the report.json made with the file, and give its sha256`
      );
    }
    const problem = handRunReportProblem(
      reportBytes.toString('utf8'),
      freezeMs,
      stage
    );
    if (problem) {
      throw new IdentityExportEventError(`${handRun.reportKey}: ${problem}`);
    }
    const mismatch = handRunPairProblem(
      bytes.toString('utf8'),
      reportBytes.toString('utf8')
    );
    if (mismatch) {
      throw new IdentityExportEventError(
        `${handRun.key} isn't the cms-fields.json of the run that wrote ${handRun.reportKey}: ${mismatch}. Make both files again in one run of the CLI with --frozen-at ${freezeMs}, and upload both.`
      );
    }
    return {
      bytes,
      source: {
        kind: 'hand_run',
        key: handRun.key,
        sha256: fileSha256,
        reportKey: handRun.reportKey,
        reportSha256,
        reportFrozenAt: freeze,
        sitePointer: pointerKey,
        sitePointerRead: pointerRead.reason
      }
    };
  }
  if (!pointerRead.found) {
    throw new IdentityExportEventError(
      `No profile site export for the freeze ${freeze}: ${pointerKey} ${pointerRead.reason === 'forbidden' ? "can't be read (S3 answers 403 for a key that doesn't exist)" : "doesn't exist"}. Run the profile site export for this freeze first: its whole, usable run writes that pointer. Only if it can't run, give a hand-run cms-fields.json as cmsFieldsAtFreeze.`
    );
  }
  const pointer = parseJson(pointerRead.text, pointerKey);
  if (pointer.frozen_at !== freeze) {
    throw new IdentityExportEventError(
      `${pointerKey} is for the freeze ${String(pointer.frozen_at)}, not ${freeze}`
    );
  }
  const prefix = runPrefixOf(
    pointer.prefix,
    `${SITE_JOB_PREFIX}/${stage}/`,
    `${pointerKey}'s prefix`
  );
  const manifestKey = `${prefix}manifest.json`;
  if (pointer.manifest !== manifestKey) {
    throw new IdentityExportEventError(
      `${pointerKey} names the manifest ${String(pointer.manifest)}, not its run's ${manifestKey}`
    );
  }
  const manifestRead = await writer.readOutside(manifestKey);
  if (!manifestRead.found) {
    throw new IdentityExportEventError(
      `${pointerKey} names ${manifestKey}, which can't be read`
    );
  }
  const manifestSha256 = sha256(manifestRead.text);
  if (pointer.manifest_sha256 !== manifestSha256) {
    throw new IdentityExportEventError(
      `${pointerKey} records the manifest's sha256 as ${String(pointer.manifest_sha256)}, but ${manifestKey} has ${manifestSha256}`
    );
  }
  const file = `${prefix}${PROFILE_SITE_CMS_FILE}`;
  const bytes = await objectBytes(file, writer.bucket, s3);
  const fileSha256 = sha256(bytes);
  const problem = profileSiteManifestProblem(
    manifestRead.text,
    fileSha256,
    freezeMs,
    stage
  );
  if (problem) {
    throw new IdentityExportEventError(`${manifestKey}: ${problem}`);
  }
  return {
    bytes,
    source: {
      kind: 'site_run',
      pointer: pointerKey,
      prefix,
      manifest: manifestKey,
      manifestSha256,
      file,
      sha256: fileSha256
    }
  };
}

/**
 * A hand-run file's bytes. S3 refusing the read (no such key, access
 * denied) names the file and the key given; its message goes to the log.
 */
async function handRunBytes(
  key: string,
  what: string,
  bucket: ExportBucket,
  s3: Pick<S3Client, 'send'>
): Promise<Buffer> {
  try {
    return await objectBytes(key, bucket, s3);
  } catch (error) {
    const { name, $metadata } = (error ?? {}) as {
      name?: unknown;
      $metadata?: unknown;
    };
    if (
      isNetworkError(error) ||
      typeof name !== 'string' ||
      ($metadata === undefined && name !== 'NoSuchKey')
    ) {
      throw error;
    }
    logger.warn(
      `[HAND-RUN FILE NOT READ] [${key}] ${String((error as Error)?.message ?? error)}`
    );
    if (name !== 'NoSuchKey' && name !== 'AccessDenied') {
      throw new IdentityExportServiceError(
        `An AWS call failed reading the hand-run ${what} at ${key}: ${errorName(error)}. It's S3 failing, not the file: run again later.`
      );
    }
    throw new IdentityExportEventError(
      `Can't read the hand-run ${what} at ${key}: ${errorName(error)}. Upload it there, or give the key it was uploaded to in cmsFieldsAtFreeze.`
    );
  }
}

/** The profile site export's pointer appeared while a hand-run run read. */
export class SitePointerAppearedError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SitePointerAppearedError';
  }
}

/**
 * Refuses a hand-run run once the profile site export's pointer for the
 * freeze exists: the site run's values win. Any error reading it refuses
 * too.
 */
async function refuseIfSiteRan(
  writer: PrivateExportWriter,
  sitePointer: string,
  before: 'manifest' | 'pointer'
): Promise<void> {
  const read = await writer.readOutside(sitePointer);
  if (read.found) {
    throw new SitePointerAppearedError(
      `The profile site export's pointer ${sitePointer} appeared while this run read the database: that run's values win over the hand-run file, so this run wrote no ${before === 'manifest' ? 'manifest and no pointer' : 'pointer'}. Run again without cmsFieldsAtFreeze.`
    );
  }
}

/**
 * Why a hand-run report.json doesn't vouch for the freeze, or null: it
 * must record this freeze (frozen_at, in milliseconds), the stage when it
 * records one, and no profile whose publication couldn't be fetched (the
 * CLI says not to use such an export).
 */
export function handRunReportProblem(
  text: string,
  freezeMs: number,
  stage: string
): string | null {
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return "it isn't JSON: give the report.json the profile site export's CLI wrote with the file";
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return "it isn't the profile site export CLI's report.json";
  }
  if (report.frozen_at !== freezeMs) {
    return `it records frozen_at ${JSON.stringify(report.frozen_at ?? null)}, not this freeze (${freezeMs}, ${new Date(freezeMs).toISOString()}): make cms-fields.json and report.json again in one run of the CLI with --frozen-at ${freezeMs}, and upload both`;
  }
  if (report.stage !== undefined && report.stage !== stage) {
    return `it is of the stage ${JSON.stringify(report.stage)}, not ${stage}`;
  }
  const profiles =
    report.profiles && typeof report.profiles === 'object'
      ? Object.values(report.profiles as Record<string, unknown>)
      : [];
  const unavailable = profiles.filter((it) => {
    const list = (it as { publication_unavailable?: unknown })
      ?.publication_unavailable;
    return Array.isArray(list) && list.length > 0;
  }).length;
  if (unavailable > 0) {
    return `${unavailable} profiles have stored publication records that couldn't be fetched, and the CLI says not to use such an export: make it again`;
  }
  return null;
}

/** "1 profile has <what> (<id>)", "2 profiles have <what> (<ids>)". */
function profilesPhrase(
  ids: readonly string[],
  one: string,
  many: string,
  what: string
): string {
  const shown = `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', ...' : ''}`;
  return `${ids.length} ${ids.length === 1 ? one : many} ${what} (${shown})`;
}

/**
 * Why a hand-run cms-fields.json isn't the one its report.json was written
 * with, or null. The report carries no hash of the file, so the two are
 * held to each other profile by profile, as the CLI writes them:
 * - every profile in the file is in the report;
 * - a profile has a primary in the file exactly when the report carries
 *   it (primary_carried);
 * - a profile with published packages in the report (packages > 0) has an
 *   archive in the file, and a profile with an archive in the file has
 *   packages or legacy packages in the report.
 * The archive itself is only a CID in the file; the freeze it was made at
 * (frozen_at inside the archive) can't be read without the archive's
 * bytes, which the hand-run path doesn't upload.
 */
export function handRunPairProblem(
  cmsText: string,
  reportText: string
): string | null {
  let cms: unknown;
  let report: { profiles?: unknown } | null;
  try {
    cms = JSON.parse(cmsText);
    report = JSON.parse(reportText) as { profiles?: unknown } | null;
  } catch {
    return "one of them isn't JSON";
  }
  if (!cms || typeof cms !== 'object' || Array.isArray(cms)) {
    return "the cms-fields.json isn't an object of profile ids";
  }
  const file = cms as Record<string, unknown>;
  const profiles =
    report?.profiles &&
    typeof report.profiles === 'object' &&
    !Array.isArray(report.profiles)
      ? (report.profiles as Record<string, unknown>)
      : null;
  if (profiles === null) return 'the report lists no profiles';
  const notInReport = Object.keys(file).filter(
    (id) => !Object.prototype.hasOwnProperty.call(profiles, id)
  );
  if (notInReport.length > 0) {
    return profilesPhrase(
      notInReport,
      "of its profiles isn't",
      "of its profiles aren't",
      'in the report'
    );
  }
  const entry = (id: string) => {
    const value = file[id];
    return value && typeof value === 'object'
      ? (value as { primary?: unknown; archive?: unknown })
      : null;
  };
  const has = (value: unknown) => value !== undefined && value !== null;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const primaries: string[] = [];
  const archives: string[] = [];
  for (const [id, raw] of Object.entries(profiles)) {
    const it = (raw ?? {}) as {
      primary_carried?: unknown;
      packages?: unknown;
      legacy_packages?: unknown;
    };
    const value = entry(id);
    if (has(value?.primary) !== (it.primary_carried === true)) {
      primaries.push(id);
    }
    const archive = has(value?.archive);
    const packages = count(it.packages);
    const legacy = count(it.legacy_packages);
    if ((packages > 0 && !archive) || (archive && packages + legacy === 0)) {
      archives.push(id);
    }
  }
  if (primaries.length > 0) {
    return profilesPhrase(
      primaries,
      'profile has',
      'profiles have',
      'a primary in one and not the other'
    );
  }
  if (archives.length > 0) {
    return profilesPhrase(
      archives,
      'profile has',
      'profiles have',
      'an archive in the file and no packages in the report, or packages and no archive'
    );
  }
  return null;
}

/** Whose run a pointer names, as read back after S3 refused to write it. */
export type PointerOwner =
  | { readonly owner: 'this run' | 'another run' }
  | { readonly owner: 'unknown'; readonly reason: string };

/**
 * Whose run the pointer at `key` names, after S3 refused to write it: this
 * run's when the SDK retried a write whose answer was lost (the first
 * write landed), another run's, or unknown when it can't be read back.
 */
async function pointerOwner(
  writer: PrivateExportWriter,
  key: string,
  prefix: string,
  manifestSha256: string
): Promise<PointerOwner> {
  try {
    const read = await writer.readOutside(key);
    if (!read.found) {
      return {
        owner: 'unknown',
        reason:
          read.reason === 'forbidden' ? 'S3 refused the read' : 'it is missing'
      };
    }
    const pointer = JSON.parse(read.text) as {
      prefix?: unknown;
      manifest_sha256?: unknown;
    };
    return {
      owner:
        pointer?.prefix === prefix &&
        pointer?.manifest_sha256 === manifestSha256
          ? 'this run'
          : 'another run'
    };
  } catch (error) {
    logger.warn(
      `[POINTER READ-BACK FAILED] ${String((error as Error)?.message ?? error)}`
    );
    return { owner: 'unknown', reason: errorName(error) };
  }
}

/** Why the pointer wasn't written, from the error and the read-back. */
function pointerErrorOf(
  key: string,
  error: unknown,
  read: PointerOwner | null
): string {
  if (read?.owner === 'another run') {
    return `${key} names another run for this freeze, written while this one ran, and was kept. Send both runs' prefix and manifestSha256 to the on-call engineer; to make this run the export, run again with replacePointer: true`;
  }
  if (read?.owner === 'unknown') {
    return `S3 refused to write ${key} because one is there, and reading it back failed (${read.reason}): whether it names this run is unknown. Ask for links by freezeAt: if their prefix is this run's, the pointer is this run's; if not, it names another run, and this run is fetched by its prefix.`;
  }
  return `The pointer write failed: ${errorName(error)}. Its message is in the function's log.`;
}

/** Presigns every object and writes the links file. */
async function writeLinks(
  writer: PrivateExportWriter,
  presign: Presigner,
  names: readonly string[],
  linksName: string
): Promise<PutResult> {
  const links: Record<string, string> = {};
  for (const name of names) {
    links[name] = await presign(
      writer.bucket,
      writer.key(name),
      PRESIGNED_URL_SECONDS
    );
  }
  return await writer.put(
    linksName,
    JSON.stringify(
      { expires_in_seconds_at_most: PRESIGNED_URL_SECONDS, links },
      null,
      2
    ),
    'application/json'
  );
}

/** What a run's summary and its manifest say about the export. */
function summaryOf(document: IdentityExportDocument) {
  return {
    format: document.format,
    exporter_revision: document.exporter_revision,
    freeze_ms: document.freeze_ms,
    tdh_block: document.tdh_block,
    tdh_block_timestamp_ms: document.tdh_block_timestamp_ms,
    extra_ids: document.extra_ids,
    cms_fields: document.cms_fields,
    acknowledged: document.acknowledged,
    rules: document.rules,
    stats: document.stats,
    notes: document.notes
  };
}

/**
 * The revision the file records: the build's commit, which an event's
 * revision must match; the event's, unchecked, when the build can't tell.
 */
function revisionOf(
  event: ExportEvent,
  built: string | null
): { revision: string; notes: string[] } {
  if (built !== null) {
    if (event.revision !== null && event.revision !== built) {
      throw new IdentityExportEventError(
        `revision ${event.revision} is not the commit this function was built from (${built}): leave revision out, or give that one`
      );
    }
    return { revision: built, notes: [] };
  }
  if (event.revision === null) {
    throw new IdentityExportEventError(
      "This function's build doesn't record its commit: give revision, the 40-hex commit it was deployed from"
    );
  }
  return {
    revision: event.revision,
    notes: [
      `the function's build commit is unknown: exporter_revision ${event.revision} is the invoker's, unchecked`
    ]
  };
}

export async function runIdentityExportJob(
  event: IdentityExportEvent,
  context: IdentityExportContext,
  deps: IdentityExportDeps = defaultDeps()
): Promise<IdentityExportResult | IdentityExportLinksResult> {
  try {
    return await runJob(event, context, deps);
  } catch (error) {
    // What the operator's out.json gets: no hostname from a network error,
    // no message from an AWS service's refusal.
    const during =
      event.job === LINKS_JOB ? 'renewing the links' : 'running the export';
    throw serviceErrorOf(networkErrorOf(error, during), during);
  }
}

async function runJob(
  event: IdentityExportEvent,
  context: IdentityExportContext,
  deps: IdentityExportDeps
): Promise<IdentityExportResult | IdentityExportLinksResult> {
  await deps.prepareEnvironment();
  const env = deps.env();
  const bucket = exportBucketOf(
    context.invokedFunctionArn,
    env.AWS_REGION ?? ''
  );
  const stage = exportStage(env.NODE_ENV);
  if (event.job === LINKS_JOB) {
    return await renewLinks(event, stage, bucket, deps);
  }
  const startedAt = deps.now();
  const built = (deps.buildCommit ?? buildCommit)();
  const { revision, notes } = revisionOf(event, built);
  // The freeze 6529.io runs with, read from its secret now and as the
  // profile site reads it, is the one the export is held to.
  const freezeSecret = await deps.identityFreezeAt();
  const freezeSetting = readFreezeSetting(freezeSecret.value);
  if (event.freezeMs !== null) {
    const problem = freezeSecretProblem(event.freezeMs, freezeSecret);
    if (problem) throw new IdentityExportEventError(problem);
  }
  const target = replicaTarget(env);
  logger.info(
    `[EXPORT START] [READ REPLICA ${target.host}] [STAGE ${stage}] [REVISION ${revision}] [BUILD ${built ?? 'unknown'}] [IDENTITY_FREEZE_AT ${freezeSetting.reading} ${freezeSetting.at}]`
  );
  const privacy = await assertBucketPrivate(deps.s3, bucket);
  const prefix = runPrefix(
    JOB_PREFIX,
    stage,
    startedAt,
    context.awsRequestId,
    event.freezeMs === null ? 'rehearsal' : null
  );
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  // A freeze has one export: a second run replaces its pointer only when
  // asked to. Checked first, so such a run doesn't read for nothing.
  const pointerKey =
    event.freezeMs === null
      ? null
      : pointerKeyOf(JOB_PREFIX, stage, event.freezeMs);
  let replacedPointer: Record<string, unknown> | null = null;
  if (pointerKey !== null) {
    const existing = await writer.readOutside(pointerKey);
    if (existing.found) {
      let previous: Record<string, unknown>;
      try {
        previous = parseJson(existing.text, pointerKey);
      } catch {
        previous = { unreadable_sha256: sha256(existing.text) };
      }
      if (!event.replacePointer) {
        throw new IdentityExportEventError(
          `${pointerKey} exists: the run under ${String(previous.prefix)} is this freeze's export. To make a new run the export instead, run again with replacePointer: true`
        );
      }
      replacedPointer = previous;
    }
  }
  // The inputs first: a bad list fails before the database is read.
  const extraIdsBytes = event.extraIds
    ? await inputBytes(event.extraIds, bucket, deps.s3)
    : null;
  const extraProfileIds = extraIdsBytes
    ? parseExtraIds(extraIdsBytes.toString('utf8'))
    : [];
  const atFreeze =
    event.freezeMs === null
      ? null
      : await cmsFieldsAtFreeze(
          writer,
          deps.s3,
          stage,
          event.freezeMs,
          event.cmsFieldsAtFreeze
        );
  if (atFreeze?.source.kind === 'hand_run') {
    logger.warn(
      `[CMS FIELDS HAND RUN] [${atFreeze.source.key}] [SHA256 ${atFreeze.source.sha256}] [REPORT ${atFreeze.source.reportKey}] [REPORT SHA256 ${atFreeze.source.reportSha256}] [NO SITE POINTER: ${atFreeze.source.sitePointerRead.toUpperCase()}]`
    );
    // The export file says so too.
    notes.push(
      `cms: the profile site export didn't run for this freeze: the profile site values are a hand-run cms-fields.json (${atFreeze.source.key}, sha256 ${atFreeze.source.sha256}), its report.json for this freeze (${atFreeze.source.reportKey}, sha256 ${atFreeze.source.reportSha256})`
    );
  }
  const cmsBytes =
    atFreeze?.bytes ??
    (event.cmsFields
      ? await inputBytes(event.cmsFields, bucket, deps.s3)
      : null);
  // A site export with no sites writes {}: at the freeze its manifest
  // vouches for it.
  const cmsFields = cmsBytes
    ? parseCmsFields(cmsBytes.toString('utf8'), {
        allowEmpty: atFreeze !== null
      })
    : undefined;
  // ...but only acknowledged: a fault that wrote {} would send every
  // identity without its value. Refused before the database is read.
  if (atFreeze !== null) {
    const empty = noCmsFieldsProblem(
      Object.keys(cmsFields ?? {}).length,
      event.acceptNoCmsFields,
      'event'
    );
    if (empty) throw new IdentityExportEventError(empty);
  }
  const extraIdsFile: InputFile | null = extraIdsBytes
    ? { count: extraProfileIds.length, sha256: sha256(extraIdsBytes) }
    : null;
  const cmsFieldsFile: CmsFieldsFile | null = cmsBytes
    ? {
        count: Object.keys(cmsFields ?? {}).length,
        sha256: sha256(cmsBytes),
        manifest:
          atFreeze?.source.kind === 'site_run'
            ? {
                key: atFreeze.source.manifest,
                sha256: atFreeze.source.manifestSha256
              }
            : null
      }
    : null;
  const source = (input: IdentityExportInput | null) =>
    input === null ? null : 'key' in input ? input.key : 'inline';
  const scope: IdentityExportScope = {
    freezeAt: iso(event.freezeMs),
    expectTdhBlock: event.expectTdhBlock,
    bulk: event.bulk,
    includeDelegations: event.includeDelegations,
    extraIds: source(event.extraIds),
    cmsFields: atFreeze
      ? atFreeze.source.kind === 'site_run'
        ? atFreeze.source.file
        : atFreeze.source.key
      : source(event.cmsFields),
    replacePointer: event.replacePointer
  };
  const elapsed = () =>
    Math.round((deps.now().getTime() - startedAt.getTime()) / 1000);
  // Progress, and the deadline: with under a minute left the run stops with
  // the step it reached, before its manifest is written.
  const step = (name: string) => {
    logger.info(`[${name}] [${elapsed()} S]`);
    const left = context.getRemainingTimeInMillis?.();
    if (left !== undefined && left < DEADLINE_MARGIN_MS) {
      throw new IdentityExportDeadlineError(name, elapsed());
    }
  };
  const snapshot = await deps.openSnapshot(target).catch((error: unknown) => {
    throw databaseErrorOf(error, 'opening the read-only snapshot');
  });
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${target.host}] [AT ${snapshot.evidence.snapshotAt}] [REPLICA LAG ${snapshot.evidence.replicaLagMs ?? 'unknown'} MS] [LAG ROW AGE ${snapshot.evidence.replicaLagAgeMs ?? 'unknown'} MS]${snapshot.evidence.replicaLagError ? ` [REPLICA LAG ERROR ${snapshot.evidence.replicaLagError}]` : ''}${snapshot.evidence.replicaLagUnknown ? ` [REPLICA LAG UNKNOWN ${snapshot.evidence.replicaLagUnknown}]` : ''} [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  // Every query of the read: its errors come back as the replica's codes.
  const reader = new ReplicaErrorsExecutor(snapshot.executor);
  let document: IdentityExportDocument;
  let gapSeconds: number | null = null;
  let gapMs: number | null = null;
  let replicaLagAccepted: ReplicaLagAccepted | null = null;
  // A rehearsal names the case a real run would refuse on, so Tuesday
  // knows which name Monday showed. It has no freeze, so it is held to
  // the minimum gap alone: a run at the freeze is never closer to it.
  let replicaLagCase = replicaLagCaseOf(
    MIN_SNAPSHOT_GAP_SECONDS * 1000,
    snapshot.evidence
  );
  try {
    if (event.freezeMs !== null) {
      const gap = checkSnapshotTime(
        event.freezeMs,
        Date.parse(snapshot.evidence.snapshotAt),
        event.acceptSnapshotGapMinutes,
        MIN_SNAPSHOT_GAP_SECONDS
      );
      gapSeconds = gap.gapSeconds;
      gapMs = gap.gapMs;
      // Against the run's own gap, as checkReplicaLag holds it.
      replicaLagCase = replicaLagCaseOf(gap.gapMs, snapshot.evidence);
      replicaLagAccepted = checkReplicaLag(
        gap.gapMs,
        snapshot.evidence,
        event.acceptUnknownReplicaLag
      );
      if (replicaLagAccepted) {
        logger.warn(
          `[REPLICA LAG ACCEPTED ${replicaLagAccepted}] [THE ROW'S REPORTED LAG, ${snapshot.evidence.replicaLagMs ?? 'NONE'} MS, STILL CHECKED] [THE ${MIN_SNAPSHOT_GAP_SECONDS} S MINIMUM GAP HELD]`
        );
      }
    }
    document = await buildIdentityExport(
      new SqlIdentityExportSource(
        <T>(sql: string, params?: Record<string, unknown>) =>
          reader.execute<T>(sql, params)
      ),
      {
        bulkThreshold: event.bulk,
        extraProfileIds,
        wavesListGiven: event.extraIds !== null,
        includeDelegations: event.includeDelegations,
        cmsFields,
        freezeMs: event.freezeMs,
        expectTdhBlock: event.expectTdhBlock,
        acceptOverCredit: event.acceptOverCredit,
        acceptEditsAfterFreeze: event.acceptEditsAfterFreeze,
        acceptRatingsChangedAfterFreeze: event.acceptRatingsChangedAfterFreeze,
        acceptMissingExtraIds: event.acceptMissingExtraIds,
        acceptProfileWritesAfterFreeze: event.acceptProfileWritesAfterFreeze,
        acceptUnmatchedCms: event.acceptUnmatchedCms,
        acceptConsolidationsAfterFreeze: event.acceptConsolidationsAfterFreeze,
        acceptNoExtraIds: event.acceptNoExtraIds,
        acceptNoCmsFields: event.acceptNoCmsFields,
        acceptBulk: event.acceptBulk,
        extraIdsFile,
        cmsFieldsFile,
        exporterRevision: revision,
        acceptStyle: 'event',
        notes,
        log: (message) => step(`IDENTITY EXPORT ${message}`)
      }
    );
  } catch (error) {
    if (error instanceof IdentityExportNotReadyError) {
      logger.warn(
        `[EXPORT REFUSED] [EXIT ${error.exitCode}] [${error.causes.join(', ')}] ${error.message}`
      );
    }
    // The run's own error is the one that matters: a failed close is only
    // logged here.
    await snapshot
      .close()
      .catch((closeError: unknown) =>
        logger.warn(`[SNAPSHOT CLOSE FAILED] ${String(closeError)}`)
      );
    // Errors the database raised are already the replica's codes (the
    // reader executor); anything else keeps its own wording.
    throw error;
  }
  await snapshot.close().catch((error: unknown) => {
    throw databaseErrorOf(error, 'closing the snapshot');
  });
  step('READ DONE');
  const { identity_sync: _sync, ...file } = document;
  const exportBytes = await jsonDocumentBytes(file);
  step('UPLOADS');
  const written: ManifestFile[] = [];
  const putJson = async (name: string, body: Buffer | string) => {
    const put = await writer.put(name, body, 'application/json');
    written.push({ name, bytes: put.bytes, sha256: put.sha256 });
    return put;
  };
  const exportPut = await putJson(EXPORT_FILE, exportBytes);
  await putJson(SUMMARY_FILE, JSON.stringify(summaryOf(document), null, 2));
  // Only an export held to the freeze is for the import.
  const manifestName = event.freezeMs === null ? UNUSABLE_MANIFEST : MANIFEST;
  const usable = manifestName === MANIFEST;
  const links = await writeLinks(
    writer,
    deps.presign,
    [...written.map((it) => it.name), manifestName],
    'links.json'
  );
  written.push({
    name: 'links.json',
    bytes: links.bytes,
    sha256: links.sha256
  });
  const finishedAt = deps.now();
  const lastAtMost = linksLastAtMost(finishedAt);
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    usable,
    ...(usable
      ? {}
      : { unusable_because: 'a rehearsal: no freeze to hold the export to' }),
    stage,
    scope,
    format: document.format,
    exporter_revision: revision,
    build_commit: built,
    frozen_at: scope.freezeAt,
    identity_freeze_at: { secret: freezeSecret.secretId, ...freezeSetting },
    cms_fields_source: atFreeze?.source ?? null,
    accept_unknown_replica_lag: event.acceptUnknownReplicaLag,
    replica_lag_accepted: replicaLagAccepted,
    replica_lag_case: replicaLagCase,
    replace_pointer: event.replacePointer,
    replaced_pointer: replacedPointer,
    snapshot_at: snapshot.evidence.snapshotAt,
    snapshot_gap_seconds: gapSeconds,
    snapshot_gap_ms: gapMs,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    tdh_block: document.tdh_block,
    identities: document.identities.length,
    ratings: document.ratings.length,
    export_sha256: exportPut.sha256,
    acknowledged: document.acknowledged,
    read: { ...snapshot.evidence, read_only: true },
    export: EXPORT_FILE,
    summary: SUMMARY_FILE,
    links: 'links.json',
    links_last_at_most: lastAtMost.toISOString(),
    files: written
  };
  // A hand-run file stands only while the profile site export hasn't run
  // for the freeze: if its pointer appeared during the read, its values
  // win, and this run writes no manifest.
  if (atFreeze?.source.kind === 'hand_run') {
    await refuseIfSiteRan(writer, atFreeze.source.sitePointer, 'manifest');
  }
  // Last in the run's prefix: a run that stops early has no manifest, and a
  // rehearsal has only manifest.unusable.json.
  const manifestPut = await writer.put(
    manifestName,
    JSON.stringify(manifest, null, 2),
    'application/json'
  );
  // Then, for the one run the import takes, a pointer from its freeze. It
  // never replaces another run's pointer unless asked to. The run is whole
  // without it: a pointer not written is reported, not fatal.
  let writtenPointer: string | null = null;
  let pointerError: string | null = null;
  // And again just before the pointer: the import takes the run the
  // pointer names. A read that fails says nothing about the site run, so
  // no pointer either.
  if (usable && pointerKey !== null && atFreeze?.source.kind === 'hand_run') {
    try {
      await refuseIfSiteRan(writer, atFreeze.source.sitePointer, 'pointer');
    } catch (error) {
      pointerError =
        error instanceof SitePointerAppearedError
          ? error.message
          : `This run wrote no pointer: the profile site export's pointer ${atFreeze.source.sitePointer} couldn't be read again just before it (${errorName(error)}), so whether that run finished meanwhile is unknown. Run again: the new run writes the pointer if the site pointer is still missing.`;
      logger.warn(
        `[POINTER NOT WRITTEN] [${pointerKey}] ${pointerError} ${String((error as Error)?.message ?? error)}`
      );
    }
  }
  if (usable && pointerKey !== null && pointerError === null) {
    try {
      await writer.putOutside(
        pointerKey,
        JSON.stringify(
          {
            frozen_at: scope.freezeAt,
            prefix,
            manifest: manifestPut.key,
            manifest_sha256: manifestPut.sha256,
            export: exportPut.key,
            export_sha256: exportPut.sha256,
            finished_at: finishedAt.toISOString()
          },
          null,
          2
        ),
        'application/json',
        { onlyIfAbsent: !event.replacePointer }
      );
      writtenPointer = pointerKey;
    } catch (error) {
      const read = isWriteConflict(error)
        ? await pointerOwner(writer, pointerKey, prefix, manifestPut.sha256)
        : null;
      if (read?.owner === 'this run') {
        // The write landed; only its answer was lost.
        writtenPointer = pointerKey;
        logger.warn(`[POINTER WRITTEN, ITS RETRY REFUSED] [${pointerKey}]`);
      } else {
        pointerError = pointerErrorOf(pointerKey, error, read);
        logger.warn(
          `[POINTER NOT WRITTEN] [${pointerKey}] ${pointerError} ${String((error as Error)?.message ?? error)}`
        );
      }
    }
  }
  const presignedManifestUrl = await deps.presign(
    bucket,
    manifestPut.key,
    PRESIGNED_URL_SECONDS
  );
  const presignedLinksUrl = await deps.presign(
    bucket,
    writer.key('links.json'),
    PRESIGNED_URL_SECONDS
  );
  const presignedPointerUrl =
    writtenPointer === null
      ? null
      : await deps.presign(bucket, writtenPointer, PRESIGNED_URL_SECONDS);
  const seconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  logger.info(
    `[EXPORT DONE] [${prefix}] [${manifestName}] [MANIFEST SHA256 ${manifestPut.sha256}] [POINTER ${writtenPointer ?? (pointerKey === null ? 'NONE (A REHEARSAL)' : 'NOT WRITTEN')}] [${writer.files} OBJECTS] [${writer.bytes} BYTES] [${seconds} S] [USABLE ${usable}] [${document.identities.length} IDENTITIES] [${document.ratings.length} RATINGS]`
  );
  return {
    job: JOB,
    bucket: bucket.name,
    stage,
    prefix,
    manifestKey: manifestPut.key,
    manifestSha256: manifestPut.sha256,
    pointerKey: writtenPointer,
    pointerError,
    replacedPointer,
    exportKey: exportPut.key,
    scope,
    cmsFieldsSource: atFreeze?.source ?? null,
    revision,
    buildCommit: built,
    files: writer.files,
    bytes: writer.bytes,
    identities: document.identities.length,
    ratings: document.ratings.length,
    tdhBlock: document.tdh_block,
    usable,
    endpoint: 'reader',
    readOnly: true,
    evidence: snapshot.evidence,
    bucketPrivacy: privacy,
    frozenAt: scope.freezeAt,
    snapshotAt: snapshot.evidence.snapshotAt,
    snapshotGapSeconds: gapSeconds,
    snapshotGapMs: gapMs,
    acceptUnknownReplicaLag: event.acceptUnknownReplicaLag,
    replicaLagAccepted,
    replicaLagCase,
    replacePointer: event.replacePointer,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    seconds,
    identityFreezeAtSecret: freezeSecret.secretId,
    identityFreezeAtReading: freezeSetting.reading,
    identityFreezeAt: freezeSetting.at,
    linksLastAtMost: lastAtMost.toISOString(),
    presignedManifestUrl,
    presignedLinksUrl,
    presignedPointerUrl
  };
}

/**
 * Fresh links for an earlier run: given its prefix, or the freeze whose
 * pointer names it. Only a run with a manifest has them.
 */
async function renewLinks(
  event: LinksEvent,
  stage: string,
  bucket: ExportBucket,
  deps: IdentityExportDeps
): Promise<IdentityExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  let prefix = event.prefix;
  let pointerKey: string | null = null;
  let pointed: Record<string, unknown> | null = null;
  if (prefix === null) {
    const key = pointerKeyOf(JOB_PREFIX, stage, event.freezeMs!);
    pointerKey = key;
    const pointer = await new PrivateExportWriter(
      deps.s3,
      bucket,
      ''
    ).readOutside(key);
    if (!pointer.found) {
      throw new IdentityExportEventError(
        `No run for that freeze: ${key} isn't there or can't be read. Pass the run's prefix instead.`
      );
    }
    pointed = parseJson(pointer.text, key);
    prefix = runPrefixOf(pointed.prefix, PREFIX_ROOT, `${key}'s prefix`);
  }
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  let found: { name: string; manifest: Manifest; text: string } | null = null;
  let forbidden = false;
  for (const name of MANIFEST_NAMES) {
    const read = await writer.read(name);
    if (read.found) {
      const manifest = parseJson(
        read.text,
        writer.key(name)
      ) as unknown as Manifest;
      if (
        manifest.schema !== MANIFEST_SCHEMA ||
        !Array.isArray(manifest.files)
      ) {
        throw new IdentityExportEventError(
          `${writer.key(name)} is not a manifest`
        );
      }
      found = { name, manifest, text: read.text };
      break;
    }
    if (read.reason === 'forbidden') forbidden = true;
  }
  if (!found) {
    throw new IdentityExportEventError(
      forbidden
        ? `No manifest under ${prefix}: S3 refused the read, as it does for a key that doesn't exist when the reader may not list the bucket. That run didn't finish, or the prefix is wrong.`
        : `No manifest under ${prefix}: that run didn't finish, or the prefix is wrong`
    );
  }
  const manifestKey = writer.key(found.name);
  const manifestSha256 = sha256(found.text);
  // The pointer names the one manifest the import takes, by its hash.
  if (
    pointed &&
    (pointed.manifest !== manifestKey ||
      pointed.manifest_sha256 !== manifestSha256)
  ) {
    throw new IdentityExportEventError(
      `The pointer for that freeze names ${String(pointed.manifest)} (sha256 ${String(pointed.manifest_sha256)}), but ${manifestKey} has sha256 ${manifestSha256}`
    );
  }
  const now = deps.now();
  const linksName = `links-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  const links = await writeLinks(
    writer,
    deps.presign,
    [...found.manifest.files.map((it) => it.name), found.name],
    linksName
  );
  return {
    job: LINKS_JOB,
    bucket: bucket.name,
    prefix,
    manifestKey,
    manifestSha256,
    pointerKey,
    linksKey: links.key,
    usable: found.name === MANIFEST,
    linksLastAtMost: linksLastAtMost(now).toISOString(),
    presignedManifestUrl: await deps.presign(
      bucket,
      manifestKey,
      PRESIGNED_URL_SECONDS
    ),
    presignedLinksUrl: await deps.presign(
      bucket,
      links.key,
      PRESIGNED_URL_SECONDS
    ),
    presignedPointerUrl:
      pointerKey === null
        ? null
        : await deps.presign(bucket, pointerKey, PRESIGNED_URL_SECONDS)
  };
}
