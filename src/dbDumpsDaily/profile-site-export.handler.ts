import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHash } from 'node:crypto';
import {
  CMS_PUBLISHED_PACKAGES_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import {
  ProfileCmsExportDb,
  ProfileCmsExporter,
  ProfileCmsPublicationFetcher
} from '@/profile-cms/chain/profile-cms-export';
import {
  cmsFieldsJson,
  exportSummary,
  getJson,
  JsonGetter,
  MAX_EXPORT_CONCURRENCY,
  reportJson,
  runProfileCmsExport,
  storedPublicationFetcher
} from '@/profile-cms/chain/profile-cms-export.run';
import { parseProfileCmsFreezeAt } from '@/profile-cms/profile-cms-identity-freeze';
import { DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
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

const logger = Logger.get('PROFILE_SITE_EXPORT');

/**
 * The chain's document store takes files of at most 2 MiB: every
 * `files/<cid>` becomes a chain document, so each is held to it.
 * cms-fields.json, report.json, links.json and the manifest are read by the
 * import's builder and by people, never stored on the chain, so they are
 * exempt (S3 takes them at any size).
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const JOB = 'profileSiteExport';
const LINKS_JOB = 'profileSiteExportLinks';
const JOB_PREFIX = 'profile-site-export';
const PREFIX_ROOT = `${JOB_PREFIX}/`;
/** The one manifest the import takes: a whole, usable run at the freeze. */
const MANIFEST = 'manifest.json';
/** A run of one profile: never imported as the export. */
const PARTIAL_MANIFEST = 'manifest.partial.json';
/** A rehearsal, or a run missing a stored publication record: never imported. */
const UNUSABLE_MANIFEST = 'manifest.unusable.json';
const MANIFEST_NAMES = [MANIFEST, PARTIAL_MANIFEST, UNUSABLE_MANIFEST];
const MANIFEST_SCHEMA = '6529.profile-site-export.manifest.v1';
/**
 * The snapshot may be taken at most this many minutes after frozenAt,
 * unless the invoker allows more with acceptSnapshotGapMinutes.
 */
export const SNAPSHOT_GAP_LIMIT_MINUTES = 90;
/**
 * A real run's snapshot must be at least this long after frozenAt on the
 * replica's clock, so writes made before the freeze have reached it.
 */
export const MIN_SNAPSHOT_GAP_SECONDS = 120;
/** More late writes than this can't be acknowledged one by one. */
const MAX_WRITES_AFTER_FREEZE = 100;
/** Below this much time left, the run stops with its progress. */
const DEADLINE_MARGIN_MS = 60_000;
const PROGRESS_EVERY = 25;

/**
 * Invoke-only jobs of the dbDumpsDaily function (its schedule sends no
 * `job`):
 * - `profileSiteExport`: the profile site export (`6529 run
 *   profile-cms:export`) on the read replica, into the private chain exports
 *   bucket, the manifest written last;
 * - `profileSiteExportLinks`: fresh download links for an earlier run, by
 *   its prefix or by the freeze it exported.
 */
export type ProfileSiteExportEvent =
  | {
      readonly job: typeof JOB;
      readonly frozenAt: number;
      readonly profile: string | null;
      readonly publicApi: string | null;
      /**
       * Allows a snapshot taken up to this many minutes after frozenAt
       * (over the 90-minute default).
       */
      readonly acceptSnapshotGapMinutes: number | null;
      /** A rehearsal: timed and checked, but never imported. */
      readonly rehearsal: boolean;
      /** Profiles exported at once, 1 to 4. */
      readonly concurrency: number;
      /**
       * Site writes after the freeze the switch owner looked at and accepted
       * (a publish that straddled the freeze), each `source:id@at` as the
       * refusal lists it.
       */
      readonly acceptWritesAfterFreeze: readonly string[];
      /**
       * The untrusted lags the run may go through, by the case names the
       * refusals use (unreadable, dated_ahead, and older_than_gap with its
       * largest row age), relying on the minimum gap after the freeze and
       * on any lag the row reports.
       */
      readonly acceptUnknownReplicaLag: readonly ReplicaLagAcceptance[];
      /**
       * Replaces the by-freeze pointer if an earlier run wrote one; without
       * it the pointer is written only where none is.
       */
      readonly replacePointer: boolean;
    }
  | {
      readonly job: typeof LINKS_JOB;
      readonly prefix: string | null;
      readonly frozenAt: number | null;
    };

export class ProfileSiteExportEventError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportEventError';
  }
}

/** The run stopped before the function's time ran out; nothing was finished. */
export class ProfileSiteExportDeadlineError extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    readonly elapsedSeconds: number,
    readonly at: string
  ) {
    super(
      `Stopped ${at} at ${done}/${total} profiles after ${elapsedSeconds} s, with less than ${DEADLINE_MARGIN_MS / 1000} s of the function's time left. No manifest was written: the export needs longer than one invocation.`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportDeadlineError';
  }
}

/** The snapshot can't stand for the freeze. */
export class ProfileSiteExportSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportSnapshotError';
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/** An ISO UTC time or 13-digit Unix milliseconds, else null. */
function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value >= 1e12 && value < 1e13 ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{13}$/.test(text)) return Number(text);
    if (ISO_UTC.test(text)) {
      const millis = Date.parse(text);
      if (
        Number.isFinite(millis) &&
        new Date(millis).toISOString().slice(0, 10) === text.slice(0, 10)
      ) {
        return millis;
      }
    }
  }
  return null;
}

function frozenAtOf(value: unknown): number {
  const millis = timeOf(value);
  if (millis === null) {
    throw new ProfileSiteExportEventError(
      'frozenAt must be an ISO UTC time (2026-11-24T00:00:00Z) or 13-digit Unix milliseconds'
    );
  }
  return millis;
}

function only(
  event: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(event).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new ProfileSiteExportEventError(
      `Unknown fields: ${unknown.join(', ')}`
    );
  }
}

/** A run's prefix: profile-site-export/<stage>/<run>/. */
const RUN_PREFIX = /^profile-site-export\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)\/$/;
/** Folders beside the runs that are not runs. */
const NOT_RUNS = ['by-freeze', 'renewed-links'];

function runPrefixOf(value: unknown): string {
  const match = typeof value === 'string' ? RUN_PREFIX.exec(value) : null;
  if (!match || match[2].includes('..') || NOT_RUNS.includes(match[2])) {
    throw new ProfileSiteExportEventError(
      `prefix must be a run's prefix, ${PREFIX_ROOT}<stage>/<run>/`
    );
  }
  return value as string;
}

/**
 * Where the links job writes a run's fresh links: beside the run, not in
 * it, so a run's folder holds only what its manifest lists.
 */
function renewedLinksKeyOf(prefix: string, now: Date): string {
  const [, stage, run] = RUN_PREFIX.exec(prefix)!;
  return `${JOB_PREFIX}/${stage}/renewed-links/${run}/links-${now
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
}

/**
 * This module's job for an invocation's event, null when the event isn't
 * one of its jobs. A job it can't read throws: a typo never falls back to
 * the daily dump or runs with a default.
 */
export function parseProfileSiteExportEvent(
  event: unknown
): ProfileSiteExportEvent | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record.job === LINKS_JOB) {
    only(record, ['job', 'prefix', 'frozenAt']);
    const hasPrefix = record.prefix !== undefined;
    const hasFreeze = record.frozenAt !== undefined;
    if (hasPrefix === hasFreeze) {
      throw new ProfileSiteExportEventError(
        'Give either prefix (a run) or frozenAt (the run its pointer names)'
      );
    }
    return {
      job: LINKS_JOB,
      prefix: hasPrefix ? runPrefixOf(record.prefix) : null,
      frozenAt: hasFreeze ? frozenAtOf(record.frozenAt) : null
    };
  }
  if (record.job !== JOB) return null;
  only(record, [
    'job',
    'frozenAt',
    'profile',
    'publicApi',
    'acceptSnapshotGapMinutes',
    'rehearsal',
    'concurrency',
    'acceptWritesAfterFreeze',
    'acceptUnknownReplicaLag',
    'replacePointer'
  ]);
  const profile = record.profile ?? null;
  if (
    profile !== null &&
    (typeof profile !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(profile))
  ) {
    throw new ProfileSiteExportEventError('profile must be a profile id');
  }
  const publicApi = record.publicApi ?? null;
  if (
    publicApi !== null &&
    (typeof publicApi !== 'string' || !/^https:\/\/[^/\s]+/.test(publicApi))
  ) {
    throw new ProfileSiteExportEventError('publicApi must be an https URL');
  }
  const accept = record.acceptSnapshotGapMinutes ?? null;
  if (
    accept !== null &&
    (typeof accept !== 'number' ||
      !Number.isSafeInteger(accept) ||
      accept < 0 ||
      accept > 7 * 24 * 60)
  ) {
    throw new ProfileSiteExportEventError(
      'acceptSnapshotGapMinutes must be a whole number of minutes'
    );
  }
  const rehearsal = record.rehearsal ?? false;
  if (typeof rehearsal !== 'boolean') {
    throw new ProfileSiteExportEventError('rehearsal must be true or false');
  }
  const concurrency = record.concurrency ?? 1;
  if (
    typeof concurrency !== 'number' ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_EXPORT_CONCURRENCY
  ) {
    throw new ProfileSiteExportEventError(
      `concurrency must be 1 to ${MAX_EXPORT_CONCURRENCY}`
    );
  }
  const acceptWrites = record.acceptWritesAfterFreeze ?? [];
  if (
    !Array.isArray(acceptWrites) ||
    acceptWrites.length > MAX_WRITES_AFTER_FREEZE ||
    acceptWrites.some(
      (write) => typeof write !== 'string' || !WRITE_TOKEN.test(write)
    )
  ) {
    throw new ProfileSiteExportEventError(
      `acceptWritesAfterFreeze must list at most ${MAX_WRITES_AFTER_FREEZE} writes, each source:id@time exactly as the refusal lists it`
    );
  }
  const acceptUnknownLag = acceptedLagCasesOf(record.acceptUnknownReplicaLag);
  const replacePointer = record.replacePointer ?? false;
  if (typeof replacePointer !== 'boolean') {
    throw new ProfileSiteExportEventError(
      'replacePointer must be true or false'
    );
  }
  if (replacePointer && (rehearsal || profile !== null)) {
    throw new ProfileSiteExportEventError(
      'replacePointer is for a real run of every profile: only that run writes the pointer'
    );
  }
  return {
    job: JOB,
    frozenAt: frozenAtOf(record.frozenAt),
    profile,
    publicApi,
    acceptSnapshotGapMinutes: accept,
    rehearsal,
    concurrency,
    acceptWritesAfterFreeze: acceptWrites as string[],
    acceptUnknownReplicaLag: acceptUnknownLag,
    replacePointer
  };
}

/**
 * Refuses a snapshot taken before the freeze, sooner after it than
 * `minGapSeconds`, or longer after it than the limit (90 minutes) or than
 * the invoker allowed.
 */
export function checkSnapshotTime(
  frozenAt: number,
  snapshotAt: number,
  acceptGapMinutes: number | null,
  minGapSeconds = 0
): { readonly gapMs: number; readonly gapSeconds: number } {
  if (!Number.isFinite(snapshotAt)) {
    throw new ProfileSiteExportSnapshotError("The snapshot's time is unknown");
  }
  // Compared in milliseconds: rounding would let a snapshot taken just
  // before the freeze, or just short of the minimum gap, through.
  const gapMs = snapshotAt - frozenAt;
  if (gapMs < 0) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot (${new Date(snapshotAt).toISOString()}) is before the freeze (${new Date(frozenAt).toISOString()})`
    );
  }
  if (gapMs < minGapSeconds * 1000) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot is ${gapMs / 1000} s after the freeze: wait until at least ${minGapSeconds} s after it, so the replica holds every write made before the freeze`
    );
  }
  const limit = Math.max(SNAPSHOT_GAP_LIMIT_MINUTES, acceptGapMinutes ?? 0);
  if (gapMs > limit * 60_000) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot is ${Math.ceil(gapMs / 60_000)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to allow that.`
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
 * Refuses a replica further behind its writer than the snapshot is after
 * the freeze: it might not yet hold writes made before the freeze. A lag
 * that can't be read, a row dated ahead of UTC, and a row older than the
 * whole gap are refused unless the invoker accepts that case by name; the
 * case accepted is returned, to be recorded. The lag a row reports is held
 * to the gap in every case: only when there is none does the minimum gap
 * alone decide.
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
    throw new ProfileSiteExportSnapshotError(
      `dated_ahead was accepted down to a ${leadBound} ms lead, but this reader's row reads ${lagCase ?? 'as fresh'}: a reader dated ahead that stopped updating reads that way once its lead has run out. Run once more without changing anything; if it reads the same, report it.`
    );
  }
  // The lag the row reports counts whenever there is one; its age only
  // when the row's timestamp can be trusted. A bounded case accepted can
  // hide a stall up to the bound's margin: that counts as lag.
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
      throw new ProfileSiteExportSnapshotError(
        `The replica ${what}, which with ${REPLICA_LAG_AGE_MARGIN_MS} ms for the row's timestamp is not less than the ${gapMs} ms since the freeze: it may not hold every write made before the freeze. ${next}`
      );
    }
  }
  if (lagCase === null) return null;
  if (lagCase === 'older_than_gap') {
    const bound = boundFor(accepted, lagCase);
    if (bound !== undefined) {
      if ((lag.replicaLagAgeMs ?? Infinity) <= bound) return lagCase;
      throw new ProfileSiteExportSnapshotError(
        `The replica's lag row is ${lag.replicaLagAgeMs} ms old, over the ${bound} ms accepted for older_than_gap: it has aged past Monday's reading, so the reader may have stopped updating its row. Report it; don't raise the bound.`
      );
    }
  } else if (lagCase === 'dated_ahead') {
    const bound = boundFor(accepted, lagCase);
    if (bound !== undefined) {
      if ((lag.replicaLagAheadMs ?? -Infinity) >= bound) return lagCase;
      throw new ProfileSiteExportSnapshotError(
        `The replica's lag row is dated ${lag.replicaLagAheadMs} ms ahead of UTC, less than the ${bound} ms accepted for dated_ahead: its lead has shrunk since Monday's reading, so the reader may have stopped updating its row. Report it; don't lower the bound.`
      );
    }
  } else if (accepted.includes(lagCase)) {
    // lagCase is 'unreadable': only the "can't read the lag on this
    // server" cases. A timeout or a refusal can come from a reader falling
    // behind.
    if (isAcceptableUnreadableLag(lag.replicaLagError)) return lagCase;
    throw new ProfileSiteExportSnapshotError(
      `unreadable was accepted, but this reading's reason (${lag.replicaLagError ?? 'no reason given'}) isn't one it covers: only ER_UNKNOWN_TABLE 1109 or ER_UNKNOWN_SYSTEM_VARIABLE 1193 (the reader isn't Aurora), no row for this server, a null lag or a null timestamp. A timeout or a refusal can come from a reader falling behind: run once more, and if it returns, report it.`
    );
  }
  const reason = lag.replicaLagError ?? 'no reason given';
  if (lagCase === 'dated_ahead') {
    throw new ProfileSiteExportSnapshotError(
      `The replica's lag row is dated ahead of UTC (${reason}): LAST_UPDATE_TIMESTAMP may not be in UTC, so the row's age is unknown. ${unknownLagSteps(lagCase, '')}`
    );
  }
  if (lagCase === 'older_than_gap') {
    throw new ProfileSiteExportSnapshotError(
      `The replica's lag row is ${lag.replicaLagAgeMs} ms old (a ${lag.replicaLagMs} ms lag), older than the ${gapMs} ms since the freeze: LAST_UPDATE_TIMESTAMP may not be in UTC, or the reader stopped updating its row. If the same refusal returns with the row's age grown by the time you waited, the reader stopped updating: report it. ${unknownLagSteps(lagCase, '')}`
    );
  }
  throw new ProfileSiteExportSnapshotError(
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
export class ProfileSiteExportDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportDatabaseError';
  }
}

/** A network call failed; its message stays in the function's log. */
export class ProfileSiteExportNetworkError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportNetworkError';
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
  return new ProfileSiteExportDatabaseError(
    failureMessage('The read replica', during, error)
  );
}

/**
 * Any other network failure (an S3 call, a stored record's gateway, the
 * public API), as its code and number only, with its own wording: its
 * message can name the host. Anything else is returned as it is.
 */
export function networkErrorOf(error: unknown, during: string): unknown {
  if (
    error instanceof ProfileSiteExportDatabaseError ||
    !isNetworkError(error)
  ) {
    return error;
  }
  logger.error(
    `[NETWORK CALL FAILED] [${during}] ${String((error as Error)?.message ?? error)}`
  );
  return new ProfileSiteExportNetworkError(
    failureMessage('A network call', during, error)
  );
}

/** An AWS service refused; its message stays in the function's log. */
export class ProfileSiteExportServiceError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportServiceError';
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
    return new ProfileSiteExportNetworkError(
      `A network call failed while ${during}: ${name}. Its message, which can name the host, is in the function's log.`
    );
  }
  logger.error(
    `[AWS CALL REFUSED] [${during}] ${String((error as Error)?.message ?? error)}`
  );
  return new ProfileSiteExportServiceError(
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
function acceptedLagCasesOf(value: unknown): ReplicaLagAcceptance[] {
  if (value === undefined || value === false) return [];
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const refuse = () =>
    new ProfileSiteExportEventError(
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

/** IDENTITY_FREEZE_AT as the profile site itself reads it. */
export interface FreezeSetting {
  readonly reading: 'unset' | 'not_a_time' | 'time';
  readonly at: number | null;
}

export function readFreezeSetting(raw: string | undefined): FreezeSetting {
  const parsed = parseProfileCmsFreezeAt(raw);
  if (parsed === undefined) return { reading: 'unset', at: null };
  if (parsed === null) return { reading: 'not_a_time', at: null };
  return { reading: 'time', at: parsed };
}

/**
 * A real run exports 6529.io's own freeze: IDENTITY_FREEZE_AT must be set,
 * be a time, and equal frozenAt.
 */
export function checkFreezeSetting(
  frozenAt: number,
  setting: FreezeSetting
): void {
  if (setting.reading === 'unset') {
    throw new ProfileSiteExportSnapshotError(
      `IDENTITY_FREEZE_AT is not set in the ${LAMBDAS_SECRET_ID} secret of this region: a real run exports 6529.io’s own freeze. Use rehearsal: true before the freeze.`
    );
  }
  if (setting.reading === 'not_a_time') {
    throw new ProfileSiteExportSnapshotError(
      `IDENTITY_FREEZE_AT in the ${LAMBDAS_SECRET_ID} secret is not a time: the run cannot tell which freeze it exports`
    );
  }
  if (setting.at !== frozenAt) {
    throw new ProfileSiteExportSnapshotError(
      `frozenAt (${new Date(frozenAt).toISOString()}) is not IDENTITY_FREEZE_AT (${new Date(setting.at!).toISOString()})`
    );
  }
}

/** The latest profile site writes in the snapshot (Unix ms, null when none). */
export interface LatestSiteWrites {
  readonly packages: number | null;
  readonly archivedPackages: number | null;
  readonly legacyPackages: number | null;
  readonly pointerEvents: number | null;
}

function msOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Reads the latest publication, archive and pointer change in the snapshot. */
export async function latestSiteWrites(
  executor: SqlExecutor
): Promise<LatestSiteWrites> {
  const row = await executor.oneOrNull<{
    packages: unknown;
    archived: unknown;
    legacy: unknown;
    events: unknown;
  }>(
    `select
       (select max(published_at) from ${PROFILE_CMS_PACKAGES_TABLE}) as packages,
       (select max(archived_at) from ${PROFILE_CMS_PACKAGES_TABLE}) as archived,
       (select max(published_at) from ${CMS_PUBLISHED_PACKAGES_TABLE}) as legacy,
       (select max(created_at) from ${PROFILE_CMS_POINTER_EVENTS_TABLE}) as events`
  );
  return {
    packages: msOrNull(row?.packages),
    archivedPackages: msOrNull(row?.archived),
    legacyPackages: msOrNull(row?.legacy),
    pointerEvents: msOrNull(row?.events)
  };
}

/** One profile site write after the freeze, by the package it concerns. */
export interface WriteAfterFreeze {
  readonly source: 'packages' | 'pointer_events' | 'legacy_packages';
  readonly packageId: string;
  readonly at: string;
  /** `source:id@at`: how a refusal lists it and acceptWritesAfterFreeze takes it. */
  readonly token: string;
}

/** A write as acceptWritesAfterFreeze takes it: `source:id@at`. */
const WRITE_TOKEN =
  /^(packages|pointer_events|legacy_packages):[^\s@,]{1,100}@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The site writes after the freeze in the snapshot, by package: a
 * publication or archive of a package, a pointer change naming one, or a
 * legacy package published. At most one more than can be acknowledged.
 */
export async function writesAfterFreeze(
  executor: SqlExecutor,
  frozenAt: number
): Promise<WriteAfterFreeze[]> {
  const rows = await executor.execute<{
    source: WriteAfterFreeze['source'];
    package_id: string;
    at: unknown;
  }>(
    `select 'packages' as source, id as package_id,
            greatest(coalesce(published_at, 0), coalesce(archived_at, 0)) as at
       from ${PROFILE_CMS_PACKAGES_TABLE}
       where published_at > :frozenAt or archived_at > :frozenAt
     union all
     select 'pointer_events' as source, package_db_id as package_id, created_at as at
       from ${PROFILE_CMS_POINTER_EVENTS_TABLE}
       where created_at > :frozenAt
     union all
     select 'legacy_packages' as source, package_hash as package_id, published_at as at
       from ${CMS_PUBLISHED_PACKAGES_TABLE}
       where published_at > :frozenAt
     limit ${MAX_WRITES_AFTER_FREEZE + 1}`,
    { frozenAt }
  );
  return rows.map((row) => {
    const packageId = String(row.package_id);
    const at = new Date(Number(row.at)).toISOString();
    return {
      source: row.source,
      packageId,
      at,
      token: `${row.source}:${packageId}@${at}`
    };
  });
}

/**
 * Refuses site writes after the freeze, unless each one is in the accepted
 * list, as `source:id@at`: a write to the same package at another time is
 * still refused.
 */
export function checkWritesAfterFreeze(
  writes: readonly WriteAfterFreeze[],
  accepted: readonly string[]
): void {
  if (writes.length > MAX_WRITES_AFTER_FREEZE) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot holds more than ${MAX_WRITES_AFTER_FREEZE} profile site writes after the freeze: it is not the state at the freeze`
    );
  }
  const open = writes.filter((write) => !accepted.includes(write.token));
  if (open.length) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot holds profile site writes after the freeze that no one has accepted: ${open
        .map((write) => write.token)
        .join(
          ', '
        )}. Send this to the on-call engineer and the switch owner; only with the switch owner's word, list these writes in acceptWritesAfterFreeze, exactly as written here.`
    );
  }
}

export interface ProfileSiteExportScope {
  /** One profile only, or null for every profile with a site. */
  readonly profile: string | null;
  readonly publicApi: string | null;
}

export interface ProfileSiteExportResult {
  readonly job: typeof JOB;
  readonly bucket: string;
  /** prod or staging, from NODE_ENV (production, development). */
  readonly stage: string;
  readonly prefix: string;
  /**
   * manifest.json for a whole usable run; manifest.partial.json for one
   * profile; manifest.unusable.json for a rehearsal or a run missing a
   * stored publication record.
   */
  readonly manifestKey: string;
  /** The manifest's sha256, as stored. */
  readonly manifestSha256: string;
  /** by-freeze/<frozenAt>.json, pointing at this run; only for manifest.json. */
  readonly pointerKey: string | null;
  /** Why the pointer couldn't be written, when it couldn't. */
  readonly pointerError: string | null;
  readonly rehearsal: boolean;
  readonly scope: ProfileSiteExportScope;
  readonly concurrency: number;
  /** Objects written under the prefix, the manifest included. */
  readonly files: number;
  readonly bytes: number;
  readonly profiles: number;
  readonly profilesWithCms: number;
  /**
   * True only for manifest.json, the manifest the import takes: false for
   * a rehearsal, one profile, or a run missing a stored publication record
   * (see unavailableProfiles).
   */
  readonly usable: boolean;
  readonly rebuiltRefused: number;
  readonly unavailableProfiles: number;
  /**
   * The endpoint the export read: always the reader (DB_HOST_READ, not
   * DB_HOST). The hostname is only in the function's log.
   */
  readonly endpoint: 'reader';
  /** The export read in one READ ONLY transaction with a consistent snapshot. */
  readonly readOnly: true;
  readonly evidence: ReadOnlyEvidence;
  readonly bucketPrivacy: BucketPrivacy;
  readonly frozenAt: string;
  /**
   * IDENTITY_FREEZE_AT as the site reads it (unset, not_a_time or time),
   * read from this secret at the run, not from the container's environment.
   */
  readonly identityFreezeAtSecret: string;
  readonly identityFreezeAtReading: FreezeSetting['reading'];
  readonly identityFreezeAt: string | null;
  /** The server's clock when the snapshot was taken. */
  readonly snapshotAt: string;
  /** Seconds from the freeze to the snapshot, rounded. */
  readonly snapshotGapSeconds: number;
  /** Milliseconds from the freeze to the snapshot: what the lag is held to. */
  readonly snapshotGapMs: number;
  /** The latest publication, archive and pointer change in the snapshot. */
  readonly latestSiteWrites: Record<string, string | null>;
  /** Site writes after the freeze, and the package ids accepted for them. */
  readonly writesAfterFreeze: readonly WriteAfterFreeze[];
  readonly acceptedWritesAfterFreeze: readonly string[];
  /** The untrusted lag cases the run was allowed to go through. */
  readonly acceptUnknownReplicaLag: readonly ReplicaLagAcceptance[];
  /** The unknown or stale lag the run accepted, or null if none. */
  readonly replicaLagAccepted: ReplicaLagAccepted | null;
  /**
   * The untrusted lag case the snapshot showed (unreadable, dated_ahead,
   * older_than_gap), or null when lag and age could be trusted. A
   * rehearsal records it too: Tuesday may accept only a case Monday showed.
   */
  readonly replicaLagCase: ReplicaLagAccepted | null;
  /** Whether the run was allowed to replace an earlier run's pointer. */
  readonly replacePointer: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
  /** The links last at most until then: sooner if their signing session ends. */
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  /** links.json: a presigned link for every object of the run. */
  readonly presignedLinksUrl: string;
  /** links.json's size: exempt from the 2 MiB limit, never on the chain. */
  readonly linksBytes: number;
  /** The pointer this run wrote, to keep with the export; null without one. */
  readonly presignedPointerUrl: string | null;
}

export interface ProfileSiteExportLinksResult {
  readonly job: typeof LINKS_JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly manifestSha256: string;
  /** The pointer the run was found by, when asked by frozenAt. */
  readonly pointerKey: string | null;
  /** The fresh links file, beside the run's folder, not in it. */
  readonly linksKey: string;
  readonly linksBytes: number;
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  readonly presignedLinksUrl: string;
  readonly presignedPointerUrl: string | null;
}

export interface ProfileSiteExportContext {
  readonly invokedFunctionArn?: string;
  readonly awsRequestId?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

export interface ProfileSiteExportDeps {
  readonly prepareEnvironment: () => Promise<void>;
  readonly env: () => Readonly<Record<string, string | undefined>>;
  /**
   * IDENTITY_FREEZE_AT read from the lambdas secret now: the environment a
   * warm container loaded at its start would miss a fix to the secret.
   */
  readonly identityFreezeAt: () => Promise<FreshSecretValue>;
  readonly s3: Pick<S3Client, 'send'>;
  readonly presign: Presigner;
  readonly openSnapshot: (target: ReplicaTarget) => Promise<ReadOnlySnapshot>;
  /**
   * The exporter; `beforeFetch` runs before each attempt at a stored
   * record, outside the attempt's retry.
   */
  readonly exporter: (
    frozenAt: number,
    beforeFetch: () => void
  ) => Promise<ProfileCmsExporter>;
  readonly getJson: JsonGetter;
  readonly now: () => Date;
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

/**
 * The job's stored-record fetcher: the deadline runs before each attempt,
 * outside the attempt's retry, so running out of time stops the export
 * instead of reading as a record that couldn't be fetched.
 */
export function jobRecordFetcher(
  frozenAt: number,
  beforeFetch: () => void,
  verify: Parameters<typeof storedPublicationFetcher>[1],
  sleep?: (ms: number) => Promise<void>
): ProfileCmsPublicationFetcher {
  return storedPublicationFetcher(frozenAt, verify, sleep, beforeFetch);
}

function defaultDeps(): ProfileSiteExportDeps {
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
    exporter: async (frozenAt, beforeFetch) => {
      const { profileCmsPublicationStorage } =
        await import('@/profile-cms/profile-cms-publication-storage');
      return new ProfileCmsExporter(
        jobRecordFetcher(frozenAt, beforeFetch, (receipt) =>
          profileCmsPublicationStorage.verify(receipt)
        )
      );
    },
    getJson,
    now: () => new Date()
  };
}

/** Presigns every object and writes the links file. */
async function linksJson(
  writer: PrivateExportWriter,
  presign: Presigner,
  names: readonly string[]
): Promise<string> {
  const links: Record<string, string> = {};
  for (const name of names) {
    links[name] = await presign(
      writer.bucket,
      writer.key(name),
      PRESIGNED_URL_SECONDS
    );
  }
  return JSON.stringify(
    { expires_in_seconds_at_most: PRESIGNED_URL_SECONDS, links },
    null,
    2
  );
}

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
): Promise<
  | { readonly owner: 'this run' | 'another run' }
  | { readonly owner: 'unknown'; readonly reason: string }
> {
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

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The pointer from a freeze to the whole run that exported it. */
function pointerKeyOf(stage: string, frozenAt: number): string {
  return `${JOB_PREFIX}/${stage}/by-freeze/${new Date(frozenAt)
    .toISOString()
    .replace(/[:.]/g, '-')}.json`;
}

export async function runProfileSiteExportJob(
  event: ProfileSiteExportEvent,
  context: ProfileSiteExportContext,
  deps: ProfileSiteExportDeps = defaultDeps()
): Promise<ProfileSiteExportResult | ProfileSiteExportLinksResult> {
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
  event: ProfileSiteExportEvent,
  context: ProfileSiteExportContext,
  deps: ProfileSiteExportDeps
): Promise<ProfileSiteExportResult | ProfileSiteExportLinksResult> {
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
  const freezeSecret = await deps.identityFreezeAt();
  const freezeSetting = readFreezeSetting(freezeSecret.value);
  // A rehearsal runs before the freeze: it reports the setting instead.
  if (!event.rehearsal) {
    checkFreezeSetting(event.frozenAt, freezeSetting);
  }
  const target = replicaTarget(env);
  logger.info(
    `[EXPORT START] [READ REPLICA ${target.host}] [STAGE ${stage}] [REHEARSAL ${event.rehearsal}] [CONCURRENCY ${event.concurrency}] [IDENTITY_FREEZE_AT ${freezeSetting.reading} ${iso(freezeSetting.at)}]`
  );
  const privacy = await assertBucketPrivate(deps.s3, bucket);
  const scope: ProfileSiteExportScope = {
    profile: event.profile,
    publicApi: event.publicApi
  };
  const parts = [
    event.rehearsal ? 'rehearsal' : null,
    event.profile ? `profile-${event.profile}` : null
  ].filter((it): it is string => !!it);
  const prefix = runPrefix(
    JOB_PREFIX,
    stage,
    startedAt,
    context.awsRequestId,
    parts.length ? parts.join('-') : null
  );
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const written: ManifestFile[] = [];
  let done = 0;
  let total = 0;
  const elapsed = () =>
    Math.round((deps.now().getTime() - startedAt.getTime()) / 1000);
  const deadline = (at: string) => {
    const left = context.getRemainingTimeInMillis?.();
    if (left !== undefined && left < DEADLINE_MARGIN_MS) {
      throw new ProfileSiteExportDeadlineError(done, total, elapsed(), at);
    }
  };
  const exporter = await deps.exporter(event.frozenAt, () =>
    deadline('before fetching a stored record')
  );
  const snapshot = await deps.openSnapshot(target).catch((error: unknown) => {
    throw databaseErrorOf(error, 'opening the read-only snapshot');
  });
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${target.host}] [AT ${snapshot.evidence.snapshotAt}] [REPLICA LAG ${snapshot.evidence.replicaLagMs ?? 'unknown'} MS] [LAG ROW AGE ${snapshot.evidence.replicaLagAgeMs ?? 'unknown'} MS]${snapshot.evidence.replicaLagError ? ` [REPLICA LAG ERROR ${snapshot.evidence.replicaLagError}]` : ''}${snapshot.evidence.replicaLagUnknown ? ` [REPLICA LAG UNKNOWN ${snapshot.evidence.replicaLagUnknown}]` : ''} [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  // Every query of the read: its errors come back as the replica's codes.
  const reader = new ReplicaErrorsExecutor(snapshot.executor);
  let run;
  let gapSeconds = 0;
  let gapMs = 0;
  let replicaLagAccepted: ReplicaLagAccepted | null = null;
  let replicaLagCase: ReplicaLagAccepted | null = null;
  let latest: LatestSiteWrites;
  let late: WriteAfterFreeze[];
  try {
    const gap = checkSnapshotTime(
      event.frozenAt,
      Date.parse(snapshot.evidence.snapshotAt),
      event.acceptSnapshotGapMinutes,
      event.rehearsal ? 0 : MIN_SNAPSHOT_GAP_SECONDS
    );
    gapSeconds = gap.gapSeconds;
    gapMs = gap.gapMs;
    // A rehearsal names the case a real run would refuse on, so Tuesday
    // knows which name Monday showed.
    // A rehearsal's against the minimum gap alone: its own frozenAt is
    // arbitrary, so a short gap would name older_than_gap on a healthy
    // reader, and a long one would hide an offset Tuesday will see.
    replicaLagCase = replicaLagCaseOf(
      event.rehearsal ? MIN_SNAPSHOT_GAP_SECONDS * 1000 : gap.gapMs,
      snapshot.evidence
    );
    latest = await latestSiteWrites(reader);
    late = await writesAfterFreeze(reader, event.frozenAt);
    // Before the freeze, sites are still published: a rehearsal records
    // what it saw instead of refusing.
    if (!event.rehearsal) {
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
      checkWritesAfterFreeze(late, event.acceptWritesAfterFreeze);
    }
    run = await runProfileCmsExport(
      {
        frozenAt: event.frozenAt,
        profile: event.profile,
        publicApi: event.publicApi
      },
      {
        db: new ProfileCmsExportDb(() => reader),
        exporter,
        concurrency: event.concurrency,
        sink: {
          writeFile: async (cid, bytes) => {
            if (!/^[A-Za-z0-9]+$/.test(cid)) {
              throw new Error(`Not a CID: ${cid}`);
            }
            if (bytes.length > MAX_FILE_BYTES) {
              throw new Error(`File ${cid} is ${bytes.length} bytes`);
            }
            const name = `files/${cid}`;
            const put = await writer.put(
              name,
              bytes,
              'application/octet-stream'
            );
            written.push({ name, bytes: put.bytes, sha256: put.sha256 });
          }
        },
        // The public check writes a failed request into report.json: its
        // code only, never a message that can name the host.
        getJson: async (url) => {
          try {
            return await deps.getJson(url);
          } catch (error) {
            logger.warn(
              `[PUBLIC API REQUEST FAILED] ${String((error as Error)?.message ?? error)}`
            );
            throw new Error(`request_failed: ${errorName(error)}`);
          }
        },
        progress: (doneNow, totalNow) => {
          done = doneNow;
          total = totalNow;
          if (doneNow === 0) {
            logger.info(`[EXPORTING ${totalNow} PROFILES]`);
          } else if (doneNow % PROGRESS_EVERY === 0 || doneNow === totalNow) {
            logger.info(`[PROFILES ${doneNow}/${totalNow}] [${elapsed()} S]`);
          }
          if (doneNow < totalNow) deadline('between profiles');
        },
        beforePublicCheck: () => deadline('before the public API check')
      }
    );
  } catch (error) {
    // The run's own error is the one that matters.
    await snapshot
      .close()
      .catch((closeError: unknown) =>
        logger.warn(`[SNAPSHOT CLOSE FAILED] ${String(closeError)}`)
      );
    // Errors the database raised are already the replica's codes (the
    // reader executor); an S3 or gateway error keeps its own wording.
    throw error;
  }
  // Nothing was written in the transaction: a failed close after a full read
  // doesn't make the export wrong.
  await snapshot
    .close()
    .catch((closeError: unknown) =>
      logger.warn(
        `[SNAPSHOT CLOSE FAILED AFTER THE READ] ${String(closeError)}`
      )
    );
  // Files written at once by several profiles: list them in one order.
  written.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const putJson = async (name: string, text: string) => {
    const put = await writer.put(name, text, 'application/json');
    written.push({ name, bytes: put.bytes, sha256: put.sha256 });
  };
  await putJson('cms-fields.json', cmsFieldsJson(run));
  await putJson('report.json', reportJson(event.frozenAt, run));
  const recordsAvailable = run.unavailableProfiles === 0;
  const manifestName =
    event.rehearsal || !recordsAvailable
      ? UNUSABLE_MANIFEST
      : event.profile
        ? PARTIAL_MANIFEST
        : MANIFEST;
  const links = await writer.put(
    'links.json',
    await linksJson(writer, deps.presign, [
      ...written.map((file) => file.name),
      manifestName
    ]),
    'application/json'
  );
  written.push({
    name: 'links.json',
    bytes: links.bytes,
    sha256: links.sha256
  });
  const finishedAt = deps.now();
  const lastAtMost = linksLastAtMost(finishedAt);
  const latestWrites = {
    packages: iso(latest.packages),
    archived_packages: iso(latest.archivedPackages),
    legacy_packages: iso(latest.legacyPackages),
    pointer_events: iso(latest.pointerEvents)
  };
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    usable: manifestName === MANIFEST,
    rehearsal: event.rehearsal,
    stage,
    scope,
    concurrency: event.concurrency,
    frozen_at: new Date(event.frozenAt).toISOString(),
    identity_freeze_at: {
      secret: freezeSecret.secretId,
      reading: freezeSetting.reading,
      at: iso(freezeSetting.at)
    },
    snapshot_at: snapshot.evidence.snapshotAt,
    snapshot_gap_seconds: gapSeconds,
    snapshot_gap_ms: gapMs,
    latest_site_writes: latestWrites,
    writes_after_freeze: late,
    accepted_writes_after_freeze: event.acceptWritesAfterFreeze,
    accept_unknown_replica_lag: event.acceptUnknownReplicaLag,
    replica_lag_accepted: replicaLagAccepted,
    replica_lag_case: replicaLagCase,
    replace_pointer: event.replacePointer,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    seconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
    profiles: run.profiles,
    profiles_with_cms: Object.keys(run.fields).length,
    rebuilt_refused: run.rebuiltRefused,
    unavailable_profiles: run.unavailableProfiles,
    read: { ...snapshot.evidence, read_only: true },
    cms_fields: 'cms-fields.json',
    report: 'report.json',
    links: 'links.json',
    links_last_at_most: lastAtMost.toISOString(),
    files: written
  };
  // Last in the run's prefix: a run that stops early has no manifest.
  const manifestPut = await writer.put(
    manifestName,
    JSON.stringify(manifest, null, 2),
    'application/json'
  );
  // Then, for the one run the import takes, a pointer from its freeze. It
  // never replaces an earlier run's pointer unless asked to. The run is
  // whole without it: a pointer not written is reported, not fatal.
  let pointerKey: string | null = null;
  let pointerError: string | null = null;
  if (manifestName === MANIFEST) {
    const key = pointerKeyOf(stage, event.frozenAt);
    try {
      await writer.putOutside(
        key,
        JSON.stringify(
          {
            frozen_at: new Date(event.frozenAt).toISOString(),
            prefix,
            manifest: manifestPut.key,
            manifest_sha256: manifestPut.sha256,
            finished_at: finishedAt.toISOString()
          },
          null,
          2
        ),
        'application/json',
        { onlyIfAbsent: !event.replacePointer }
      );
      pointerKey = key;
    } catch (error) {
      const read = isWriteConflict(error)
        ? await pointerOwner(writer, key, prefix, manifestPut.sha256)
        : null;
      if (read?.owner === 'this run') {
        // The write landed; only its answer was lost.
        pointerKey = key;
        logger.warn(`[POINTER WRITTEN, ITS RETRY REFUSED] [${key}]`);
      } else {
        pointerError =
          read?.owner === 'another run'
            ? `${key} already names an earlier run for this freeze, and was kept. To make this run the export, run again with replacePointer: true.`
            : read?.owner === 'unknown'
              ? `S3 refused to write ${key} because one is there, and reading it back failed (${read.reason}): whether it names this run is unknown. Ask for links by frozenAt: if their prefix is this run's, the pointer is this run's; if not, it names an earlier run, and this run is fetched by its prefix.`
              : `The pointer write failed: ${errorName(error)}. Its message is in the function's log.`;
        logger.warn(
          `[POINTER NOT WRITTEN] [${key}] ${pointerError} ${String((error as Error)?.message ?? error)}`
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
    pointerKey === null
      ? null
      : await deps.presign(bucket, pointerKey, PRESIGNED_URL_SECONDS);
  const seconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  logger.info(
    `[EXPORT DONE] [${prefix}] [${manifestName}] [MANIFEST SHA256 ${manifestPut.sha256}] [POINTER ${pointerKey ?? 'NOT WRITTEN'}] [${writer.files} OBJECTS] [${writer.bytes} BYTES] [${seconds} S] ${exportSummary(run).trim()}`
  );
  return {
    job: JOB,
    bucket: bucket.name,
    stage,
    prefix,
    manifestKey: manifestPut.key,
    manifestSha256: manifestPut.sha256,
    pointerKey,
    pointerError,
    rehearsal: event.rehearsal,
    scope,
    concurrency: event.concurrency,
    files: writer.files,
    bytes: writer.bytes,
    profiles: run.profiles,
    profilesWithCms: Object.keys(run.fields).length,
    usable: manifestName === MANIFEST,
    rebuiltRefused: run.rebuiltRefused,
    unavailableProfiles: run.unavailableProfiles,
    endpoint: 'reader',
    readOnly: true,
    evidence: snapshot.evidence,
    bucketPrivacy: privacy,
    frozenAt: new Date(event.frozenAt).toISOString(),
    identityFreezeAtSecret: freezeSecret.secretId,
    identityFreezeAtReading: freezeSetting.reading,
    identityFreezeAt: iso(freezeSetting.at),
    snapshotAt: snapshot.evidence.snapshotAt,
    snapshotGapSeconds: gapSeconds,
    snapshotGapMs: gapMs,
    latestSiteWrites: latestWrites,
    writesAfterFreeze: late,
    acceptedWritesAfterFreeze: event.acceptWritesAfterFreeze,
    acceptUnknownReplicaLag: event.acceptUnknownReplicaLag,
    replicaLagAccepted,
    replicaLagCase,
    replacePointer: event.replacePointer,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    seconds,
    linksLastAtMost: lastAtMost.toISOString(),
    presignedManifestUrl,
    presignedLinksUrl,
    linksBytes: links.bytes,
    presignedPointerUrl
  };
}

/**
 * Fresh links for an earlier run: given its prefix, or the freeze whose
 * pointer names it. Only a run with a manifest has them.
 */
async function renewLinks(
  event: Extract<ProfileSiteExportEvent, { job: typeof LINKS_JOB }>,
  stage: string,
  bucket: ExportBucket,
  deps: ProfileSiteExportDeps
): Promise<ProfileSiteExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  let prefix = event.prefix;
  let pointerKey: string | null = null;
  let pointed: { manifest?: unknown; manifest_sha256?: unknown } | null = null;
  if (prefix === null) {
    const key = pointerKeyOf(stage, event.frozenAt!);
    const pointer = await new PrivateExportWriter(
      deps.s3,
      bucket,
      ''
    ).readOutside(key);
    if (!pointer.found) {
      throw new ProfileSiteExportEventError(
        `No run for that freeze: ${key} isn't there or can't be read. Pass the run's prefix instead.`
      );
    }
    pointerKey = key;
    pointed = JSON.parse(pointer.text) as {
      prefix?: unknown;
      manifest?: unknown;
      manifest_sha256?: unknown;
    };
    prefix = runPrefixOf((pointed as { prefix?: unknown }).prefix);
  }
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  let found: { name: string; manifest: Manifest; text: string } | null = null;
  let forbidden = false;
  for (const name of MANIFEST_NAMES) {
    const read = await writer.read(name);
    if (read.found) {
      const manifest = JSON.parse(read.text) as Manifest;
      if (
        manifest?.schema !== MANIFEST_SCHEMA ||
        !Array.isArray(manifest.files)
      ) {
        throw new ProfileSiteExportEventError(
          `${writer.key(name)} is not a manifest`
        );
      }
      found = { name, manifest, text: read.text };
      break;
    }
    if (read.reason === 'forbidden') forbidden = true;
  }
  if (!found) {
    throw new ProfileSiteExportEventError(
      forbidden
        ? `No manifest under ${prefix}: S3 refused the read, as it does for a key that doesn't exist when the reader may not list the bucket. That run didn't finish, or the prefix is wrong.`
        : `No manifest under ${prefix}: that run didn't finish, or the prefix is wrong`
    );
  }
  const manifestKey = writer.key(found.name);
  const manifestSha256 = createHash('sha256')
    .update(Buffer.from(found.text, 'utf8'))
    .digest('hex');
  // The pointer names the one manifest the import takes, by its hash.
  if (
    pointed &&
    (pointed.manifest !== manifestKey ||
      pointed.manifest_sha256 !== manifestSha256)
  ) {
    throw new ProfileSiteExportEventError(
      `The pointer for that freeze names ${String(pointed.manifest)} (sha256 ${String(pointed.manifest_sha256)}), but ${manifestKey} has sha256 ${manifestSha256}`
    );
  }
  const now = deps.now();
  const links = await writer.putOutside(
    renewedLinksKeyOf(prefix, now),
    await linksJson(writer, deps.presign, [
      ...found.manifest.files.map((file) => file.name),
      found.name
    ]),
    'application/json'
  );
  return {
    job: LINKS_JOB,
    bucket: bucket.name,
    prefix,
    manifestKey,
    manifestSha256,
    pointerKey,
    linksKey: links.key,
    linksBytes: links.bytes,
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
