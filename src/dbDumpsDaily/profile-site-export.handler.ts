import { S3Client } from '@aws-sdk/client-s3';
import {
  CMS_PUBLISHED_PACKAGES_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import {
  ProfileCmsExportDb,
  ProfileCmsExporter
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
import { SqlExecutor } from '@/sql-executor';
import {
  assertBucketPrivate,
  BucketPrivacy,
  ExportBucket,
  exportBucketOf,
  exportStage,
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
/** Below this much time left, the run stops with its progress. */
const DEADLINE_MARGIN_MS = 60_000;
const PROGRESS_EVERY = 25;

/**
 * Invoke-only jobs of the dbDumpsDaily function (its schedule sends no
 * `job`):
 * - `profileSiteExport`: the profile site export (`6529 run
 *   profile-cms:export`) on the read replica, into the private chain exports
 *   bucket, the manifest written last;
 * - `profileSiteExportLinks`: fresh download links for an earlier run.
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
    }
  | { readonly job: typeof LINKS_JOB; readonly prefix: string };

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
    only(record, ['job', 'prefix']);
    const prefix = record.prefix;
    if (
      typeof prefix !== 'string' ||
      !prefix.startsWith(PREFIX_ROOT) ||
      !prefix.endsWith('/') ||
      prefix.includes('..') ||
      prefix.includes('/by-freeze/') ||
      !/^[A-Za-z0-9/_.-]+$/.test(prefix)
    ) {
      throw new ProfileSiteExportEventError(
        `prefix must be a run's prefix under ${PREFIX_ROOT}, ending in /`
      );
    }
    return { job: LINKS_JOB, prefix };
  }
  if (record.job !== JOB) return null;
  only(record, [
    'job',
    'frozenAt',
    'profile',
    'publicApi',
    'acceptSnapshotGapMinutes',
    'rehearsal',
    'concurrency'
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
  return {
    job: JOB,
    frozenAt: frozenAtOf(record.frozenAt),
    profile,
    publicApi,
    acceptSnapshotGapMinutes: accept,
    rehearsal,
    concurrency
  };
}

/**
 * Refuses a snapshot taken before the freeze, or longer after it than the
 * limit (90 minutes) or than the invoker allowed.
 */
export function checkSnapshotTime(
  frozenAt: number,
  snapshotAt: number,
  acceptGapMinutes: number | null
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
  const limit = Math.max(SNAPSHOT_GAP_LIMIT_MINUTES, acceptGapMinutes ?? 0);
  if (gapSeconds > limit * 60) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot is ${Math.ceil(gapSeconds / 60)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to allow that.`
    );
  }
  return { gapSeconds };
}

/**
 * The freeze the run says it exports must be 6529.io's own: when
 * IDENTITY_FREEZE_AT is set, frozenAt must equal it.
 */
export function checkFreezeSetting(
  frozenAt: number,
  identityFreezeAt: string | undefined
): void {
  if (identityFreezeAt === undefined || identityFreezeAt.trim() === '') return;
  const setting = timeOf(identityFreezeAt);
  if (setting === null) {
    throw new ProfileSiteExportSnapshotError(
      'IDENTITY_FREEZE_AT is set but is not a time: the run cannot tell which freeze it exports'
    );
  }
  if (setting !== frozenAt) {
    throw new ProfileSiteExportSnapshotError(
      `frozenAt (${new Date(frozenAt).toISOString()}) is not IDENTITY_FREEZE_AT (${new Date(setting).toISOString()})`
    );
  }
}

/** The latest profile site writes in the snapshot (Unix ms, null when none). */
export interface LatestSiteWrites {
  readonly packages: number | null;
  readonly legacyPackages: number | null;
  readonly pointerEvents: number | null;
}

function msOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Reads the latest publication and pointer change in the snapshot. */
export async function latestSiteWrites(
  executor: SqlExecutor
): Promise<LatestSiteWrites> {
  const row = await executor.oneOrNull<{
    packages: unknown;
    legacy: unknown;
    events: unknown;
  }>(
    `select
       (select max(published_at) from ${PROFILE_CMS_PACKAGES_TABLE}) as packages,
       (select max(published_at) from ${CMS_PUBLISHED_PACKAGES_TABLE}) as legacy,
       (select max(created_at) from ${PROFILE_CMS_POINTER_EVENTS_TABLE}) as events`
  );
  return {
    packages: msOrNull(row?.packages),
    legacyPackages: msOrNull(row?.legacy),
    pointerEvents: msOrNull(row?.events)
  };
}

/** Refuses a snapshot that holds a site publication or pointer change after the freeze. */
export function checkNoWritesAfterFreeze(
  frozenAt: number,
  latest: LatestSiteWrites
): void {
  const after = Object.entries(latest).filter(
    ([, at]) => at !== null && at > frozenAt
  );
  if (after.length) {
    throw new ProfileSiteExportSnapshotError(
      `The snapshot holds profile site writes after the freeze (${after
        .map(([name, at]) => `${name} at ${new Date(at!).toISOString()}`)
        .join(', ')}): it is not the state at the freeze`
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
  readonly prefix: string;
  /**
   * manifest.json for a whole usable run; manifest.partial.json for one
   * profile; manifest.unusable.json for a rehearsal or a run missing a
   * stored publication record.
   */
  readonly manifestKey: string;
  /** by-freeze/<frozenAt>.json, pointing at this run; only for manifest.json. */
  readonly pointerKey: string | null;
  readonly rehearsal: boolean;
  readonly scope: ProfileSiteExportScope;
  readonly concurrency: number;
  /** Objects written under the prefix, the manifest included. */
  readonly files: number;
  readonly bytes: number;
  readonly profiles: number;
  readonly profilesWithCms: number;
  /** False when a stored publication record couldn't be fetched: don't use it. */
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
  /** IDENTITY_FREEZE_AT as the function read it, or null when unset. */
  readonly identityFreezeAt: string | null;
  /** The server's clock when the snapshot was taken. */
  readonly snapshotAt: string;
  /** Seconds from the freeze to the snapshot. */
  readonly snapshotGapSeconds: number;
  /** The latest publication and pointer change in the snapshot. */
  readonly latestSiteWrites: Record<string, string | null>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
  /** The links last at most until then: sooner if their signing session ends. */
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  /** links.json: a presigned link for every object of the run. */
  readonly presignedLinksUrl: string;
}

export interface ProfileSiteExportLinksResult {
  readonly job: typeof LINKS_JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly linksKey: string;
  readonly linksLastAtMost: string;
  readonly presignedManifestUrl: string;
  readonly presignedLinksUrl: string;
}

export interface ProfileSiteExportContext {
  readonly invokedFunctionArn?: string;
  readonly awsRequestId?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

export interface ProfileSiteExportDeps {
  readonly prepareEnvironment: () => Promise<void>;
  readonly env: () => Readonly<Record<string, string | undefined>>;
  readonly s3: Pick<S3Client, 'send'>;
  readonly presign: Presigner;
  readonly openSnapshot: (target: ReplicaTarget) => Promise<ReadOnlySnapshot>;
  /** The exporter; `beforeFetch` runs before each fetch of a stored record. */
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

function defaultDeps(): ProfileSiteExportDeps {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  return {
    prepareEnvironment: async () => {
      const { prepEnvironment } = await import('@/env');
      await prepEnvironment();
    },
    env: () => process.env,
    s3,
    presign: s3Presigner(s3),
    openSnapshot: (target) => openReadOnlySnapshot(target),
    exporter: async (frozenAt, beforeFetch) => {
      const { profileCmsPublicationStorage } =
        await import('@/profile-cms/profile-cms-publication-storage');
      return new ProfileCmsExporter(
        storedPublicationFetcher(frozenAt, (receipt) => {
          beforeFetch();
          return profileCmsPublicationStorage.verify(receipt);
        })
      );
    },
    getJson,
    now: () => new Date()
  };
}

/** Presigns every object and writes the links file. */
async function writeLinks(
  writer: PrivateExportWriter,
  presign: Presigner,
  names: readonly string[],
  linksName: string
) {
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

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
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
  if (event.job === LINKS_JOB) {
    return await renewLinks(event.prefix, bucket, deps);
  }
  const startedAt = deps.now();
  const identityFreezeAt = env.IDENTITY_FREEZE_AT?.trim() || null;
  // A rehearsal runs before the freeze, so it is not held to the setting.
  if (!event.rehearsal) {
    checkFreezeSetting(event.frozenAt, env.IDENTITY_FREEZE_AT);
  }
  const target = replicaTarget(env);
  logger.info(
    `[EXPORT START] [READ REPLICA ${target.host}] [REHEARSAL ${event.rehearsal}] [CONCURRENCY ${event.concurrency}]`
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
  const stage = exportStage(env.NODE_ENV);
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
    `[READ ONLY SNAPSHOT] [HOST ${snapshot.evidence.host}] [AT ${snapshot.evidence.snapshotAt}] [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  let run;
  let gapSeconds = 0;
  let latest: LatestSiteWrites;
  try {
    gapSeconds = checkSnapshotTime(
      event.frozenAt,
      Date.parse(snapshot.evidence.snapshotAt),
      event.acceptSnapshotGapMinutes
    ).gapSeconds;
    latest = await latestSiteWrites(snapshot.executor);
    // Before the freeze, sites are still published: a rehearsal records
    // what it saw instead of refusing.
    if (!event.rehearsal) {
      checkNoWritesAfterFreeze(event.frozenAt, latest);
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
  const usable = run.unavailableProfiles === 0;
  const manifestName =
    event.rehearsal || !usable
      ? UNUSABLE_MANIFEST
      : event.profile
        ? PARTIAL_MANIFEST
        : MANIFEST;
  const links = await writeLinks(
    writer,
    deps.presign,
    [...written.map((file) => file.name), manifestName],
    'links.json'
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
    legacy_packages: iso(latest.legacyPackages),
    pointer_events: iso(latest.pointerEvents)
  };
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    usable: manifestName === MANIFEST,
    rehearsal: event.rehearsal,
    scope,
    concurrency: event.concurrency,
    frozen_at: new Date(event.frozenAt).toISOString(),
    identity_freeze_at: identityFreezeAt,
    snapshot_at: snapshot.evidence.snapshotAt,
    snapshot_gap_seconds: gapSeconds,
    latest_site_writes: latestWrites,
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
  const manifestKey = (
    await writer.put(
      manifestName,
      JSON.stringify(manifest, null, 2),
      'application/json'
    )
  ).key;
  // Then, for the one run the import takes, a pointer from its freeze.
  let pointerKey: string | null = null;
  if (manifestName === MANIFEST) {
    pointerKey = `${JOB_PREFIX}/${stage}/by-freeze/${new Date(event.frozenAt)
      .toISOString()
      .replace(/[:.]/g, '-')}.json`;
    await writer.putOutside(
      pointerKey,
      JSON.stringify(
        {
          frozen_at: new Date(event.frozenAt).toISOString(),
          prefix,
          manifest: manifestKey,
          finished_at: finishedAt.toISOString()
        },
        null,
        2
      ),
      'application/json'
    );
  }
  const presignedManifestUrl = await deps.presign(
    bucket,
    manifestKey,
    PRESIGNED_URL_SECONDS
  );
  const presignedLinksUrl = await deps.presign(
    bucket,
    writer.key('links.json'),
    PRESIGNED_URL_SECONDS
  );
  const seconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  logger.info(
    `[EXPORT DONE] [${prefix}] [${manifestName}] [${writer.files} OBJECTS] [${writer.bytes} BYTES] [${seconds} S] ${exportSummary(run).trim()}`
  );
  return {
    job: JOB,
    bucket: bucket.name,
    prefix,
    manifestKey,
    pointerKey,
    rehearsal: event.rehearsal,
    scope,
    concurrency: event.concurrency,
    files: writer.files,
    bytes: writer.bytes,
    profiles: run.profiles,
    profilesWithCms: Object.keys(run.fields).length,
    usable,
    rebuiltRefused: run.rebuiltRefused,
    unavailableProfiles: run.unavailableProfiles,
    host: snapshot.evidence.host,
    readOnly: true,
    evidence: snapshot.evidence,
    bucketPrivacy: privacy,
    frozenAt: new Date(event.frozenAt).toISOString(),
    identityFreezeAt,
    snapshotAt: snapshot.evidence.snapshotAt,
    snapshotGapSeconds: gapSeconds,
    latestSiteWrites: latestWrites,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    seconds,
    linksLastAtMost: lastAtMost.toISOString(),
    presignedManifestUrl,
    presignedLinksUrl
  };
}

/** Fresh links for an earlier run: only a run with a manifest has them. */
async function renewLinks(
  prefix: string,
  bucket: ExportBucket,
  deps: ProfileSiteExportDeps
): Promise<ProfileSiteExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  let found: { name: string; manifest: Manifest } | null = null;
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
      found = { name, manifest };
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
  const now = deps.now();
  const linksName = `links-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  const links = await writeLinks(
    writer,
    deps.presign,
    [...found.manifest.files.map((file) => file.name), found.name],
    linksName
  );
  return {
    job: LINKS_JOB,
    bucket: bucket.name,
    prefix,
    manifestKey: writer.key(found.name),
    linksKey: links.key,
    linksLastAtMost: linksLastAtMost(now).toISOString(),
    presignedManifestUrl: await deps.presign(
      bucket,
      writer.key(found.name),
      PRESIGNED_URL_SECONDS
    ),
    presignedLinksUrl: await deps.presign(
      bucket,
      links.key,
      PRESIGNED_URL_SECONDS
    )
  };
}
