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
import { SqlExecutor } from '@/sql-executor';
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
  isWriteConflict,
  linksLastAtMost,
  Presigner,
  PRESIGNED_URL_SECONDS,
  PrivateExportWriter,
  runPrefix,
  s3Presigner
} from './chain-exports/private-export-bucket';
import {
  openReadOnlySnapshot,
  ReadOnlyEvidence,
  ReadOnlySnapshot,
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
       * Runs although the replica's lag can't be read, relying on the
       * minimum gap after the freeze alone.
       */
      readonly acceptUnknownReplicaLag: boolean;
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
  const acceptUnknownLag = record.acceptUnknownReplicaLag ?? false;
  if (typeof acceptUnknownLag !== 'boolean') {
    throw new ProfileSiteExportEventError(
      'acceptUnknownReplicaLag must be true or false'
    );
  }
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
): { readonly gapSeconds: number } {
  if (!Number.isFinite(snapshotAt)) {
    throw new ProfileSiteExportSnapshotError("The snapshot's time is unknown");
  }
  const gapSeconds = Math.round((snapshotAt - frozenAt) / 1000);
  if (gapSeconds < 0) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot (${new Date(snapshotAt).toISOString()}) is before the freeze (${new Date(frozenAt).toISOString()})`
    );
  }
  if (gapSeconds < minGapSeconds) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot is ${gapSeconds} s after the freeze: wait until at least ${minGapSeconds} s after it, so the replica holds every write made before the freeze`
    );
  }
  const limit = Math.max(SNAPSHOT_GAP_LIMIT_MINUTES, acceptGapMinutes ?? 0);
  if (gapSeconds > limit * 60) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot is ${Math.ceil(gapSeconds / 60)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to allow that.`
    );
  }
  return { gapSeconds };
}

/**
 * Refuses a replica further behind its writer than the snapshot is after
 * the freeze: it might not yet hold writes made before the freeze. An
 * unknown lag is refused unless the invoker accepts relying on the minimum
 * gap alone.
 */
export function checkReplicaLag(
  gapSeconds: number,
  replicaLagMs: number | null,
  acceptUnknown = false
): void {
  if (replicaLagMs === null && !acceptUnknown) {
    throw new ProfileSiteExportSnapshotError(
      "The replica's lag can't be read (information_schema.replica_host_status): only the gap since the freeze shows it holds the writes made before it. To rely on that gap alone, run again with acceptUnknownReplicaLag: true."
    );
  }
  if (replicaLagMs !== null && replicaLagMs >= gapSeconds * 1000) {
    throw new ProfileSiteExportSnapshotError(
      `The replica is ${replicaLagMs} ms behind its writer, not less than the ${gapSeconds} s since the freeze: it may not hold every write made before the freeze. Try again later.`
    );
  }
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
  /** The read replica the export read from (DB_HOST_READ, not DB_HOST). */
  readonly host: string;
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
  /** Seconds from the freeze to the snapshot. */
  readonly snapshotGapSeconds: number;
  /** The latest publication, archive and pointer change in the snapshot. */
  readonly latestSiteWrites: Record<string, string | null>;
  /** Site writes after the freeze, and the package ids accepted for them. */
  readonly writesAfterFreeze: readonly WriteAfterFreeze[];
  readonly acceptedWritesAfterFreeze: readonly string[];
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
 * Whether the pointer at `key` names this run: after a lost answer the
 * SDK writes again, and S3 refuses the retry because the first write
 * landed.
 */
async function pointerNamesRun(
  writer: PrivateExportWriter,
  key: string,
  prefix: string,
  manifestSha256: string
): Promise<boolean> {
  try {
    const read = await writer.readOutside(key);
    if (!read.found) return false;
    const pointer = JSON.parse(read.text) as {
      prefix?: unknown;
      manifest_sha256?: unknown;
    };
    return (
      pointer.prefix === prefix && pointer.manifest_sha256 === manifestSha256
    );
  } catch {
    return false;
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
  const snapshot = await deps.openSnapshot(target);
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${snapshot.evidence.host}] [AT ${snapshot.evidence.snapshotAt}] [REPLICA LAG ${snapshot.evidence.replicaLagMs ?? 'unknown'} MS] [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  let run;
  let gapSeconds = 0;
  let latest: LatestSiteWrites;
  let late: WriteAfterFreeze[];
  try {
    gapSeconds = checkSnapshotTime(
      event.frozenAt,
      Date.parse(snapshot.evidence.snapshotAt),
      event.acceptSnapshotGapMinutes,
      event.rehearsal ? 0 : MIN_SNAPSHOT_GAP_SECONDS
    ).gapSeconds;
    latest = await latestSiteWrites(snapshot.executor);
    late = await writesAfterFreeze(snapshot.executor, event.frozenAt);
    // Before the freeze, sites are still published: a rehearsal records
    // what it saw instead of refusing.
    if (!event.rehearsal) {
      checkReplicaLag(
        gapSeconds,
        snapshot.evidence.replicaLagMs,
        event.acceptUnknownReplicaLag
      );
      checkWritesAfterFreeze(late, event.acceptWritesAfterFreeze);
    }
    run = await runProfileCmsExport(
      {
        frozenAt: event.frozenAt,
        profile: event.profile,
        publicApi: event.publicApi
      },
      {
        db: new ProfileCmsExportDb(() => snapshot.executor),
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
        getJson: deps.getJson,
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
    latest_site_writes: latestWrites,
    writes_after_freeze: late,
    accepted_writes_after_freeze: event.acceptWritesAfterFreeze,
    accept_unknown_replica_lag: event.acceptUnknownReplicaLag,
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
      if (
        isWriteConflict(error) &&
        (await pointerNamesRun(writer, key, prefix, manifestPut.sha256))
      ) {
        // The write landed; only its answer was lost.
        pointerKey = key;
        logger.warn(`[POINTER WRITTEN, ITS RETRY REFUSED] [${key}]`);
      } else {
        pointerError = isWriteConflict(error)
          ? `${key} already names an earlier run for this freeze, and was kept. To make this run the export, run again with replacePointer: true.`
          : String((error as Error)?.message ?? error);
        logger.warn(`[POINTER NOT WRITTEN] [${key}] ${pointerError}`);
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
    host: snapshot.evidence.host,
    readOnly: true,
    evidence: snapshot.evidence,
    bucketPrivacy: privacy,
    frozenAt: new Date(event.frozenAt).toISOString(),
    identityFreezeAtSecret: freezeSecret.secretId,
    identityFreezeAtReading: freezeSetting.reading,
    identityFreezeAt: iso(freezeSetting.at),
    snapshotAt: snapshot.evidence.snapshotAt,
    snapshotGapSeconds: gapSeconds,
    latestSiteWrites: latestWrites,
    writesAfterFreeze: late,
    acceptedWritesAfterFreeze: event.acceptWritesAfterFreeze,
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
