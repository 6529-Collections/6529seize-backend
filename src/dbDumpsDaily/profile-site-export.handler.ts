import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  reportJson,
  runProfileCmsExport,
  storedPublicationFetcher
} from '@/profile-cms/chain/profile-cms-export.run';
import {
  accountIdFromFunctionArn,
  assertBucketPrivate,
  BucketPrivacy,
  chainExportsBucketName,
  credentialsExpiry,
  exportStage,
  linksExpireAt,
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
const PREFIX_ROOT = 'profile-site-export/';
const MANIFEST = 'manifest.json';
/** A run with a publication record it couldn't fetch must not be imported. */
const UNUSABLE_MANIFEST = 'manifest.unusable.json';
const MANIFEST_SCHEMA = '6529.profile-site-export.manifest.v1';
/** The snapshot may be at most this long after the freeze, unless acknowledged. */
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
      /** Accepts a snapshot up to this many minutes after the freeze. */
      readonly acceptSnapshotGapMinutes: number | null;
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
    readonly elapsedSeconds: number
  ) {
    super(
      `Stopped at ${done}/${total} profiles after ${elapsedSeconds} s, with less than ${DEADLINE_MARGIN_MS / 1000} s of the function's time left. No manifest was written: the export needs longer than one invocation.`
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

function frozenAtOf(value: unknown): number {
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
  throw new ProfileSiteExportEventError(
    'frozenAt must be an ISO UTC time (2026-11-24T00:00:00Z) or 13-digit Unix milliseconds'
  );
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
    'acceptSnapshotGapMinutes'
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
  return {
    job: JOB,
    frozenAt: frozenAtOf(record.frozenAt),
    profile,
    publicApi,
    acceptSnapshotGapMinutes: accept
  };
}

/**
 * Refuses a snapshot taken before the freeze, or longer after it than the
 * limit (90 minutes) or than the invoker acknowledged.
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
      `The snapshot is ${Math.ceil(gapSeconds / 60)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to accept that.`
    );
  }
  return { gapSeconds };
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
  /** manifest.json, or manifest.unusable.json when `usable` is false. */
  readonly manifestKey: string;
  readonly scope: ProfileSiteExportScope;
  /** Objects written, the manifest and the links file included. */
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
  /** The server's clock when the snapshot was taken. */
  readonly snapshotAt: string;
  /** Seconds from the freeze to the snapshot. */
  readonly snapshotGapSeconds: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
  /** When the links stop working: 6 hours, or the signing credentials' end. */
  readonly linksExpireAt: string;
  readonly linksLimitedByCredentials: boolean;
  readonly presignedManifestUrl: string;
  /** links.json: a presigned link for every object of the run. */
  readonly presignedLinksUrl: string;
}

export interface ProfileSiteExportLinksResult {
  readonly job: typeof LINKS_JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly linksKey: string;
  readonly usable: boolean;
  readonly linksExpireAt: string;
  readonly linksLimitedByCredentials: boolean;
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
  readonly exporter: (frozenAt: number) => Promise<ProfileCmsExporter>;
  readonly getJson: JsonGetter;
  readonly now: () => Date;
  readonly credentialsExpiry: () => Promise<Date | null>;
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
    exporter: async (frozenAt) => {
      const { profileCmsPublicationStorage } =
        await import('@/profile-cms/profile-cms-publication-storage');
      return new ProfileCmsExporter(
        storedPublicationFetcher(frozenAt, (receipt) =>
          profileCmsPublicationStorage.verify(receipt)
        )
      );
    },
    getJson,
    now: () => new Date(),
    credentialsExpiry: () => credentialsExpiry(s3)
  };
}

function bucketOf(
  context: ProfileSiteExportContext,
  env: Readonly<Record<string, string | undefined>>
): string {
  return chainExportsBucketName(
    accountIdFromFunctionArn(context.invokedFunctionArn),
    env.AWS_REGION ?? ''
  );
}

/** Presigns every object and writes the links file; returns its key. */
async function writeLinks(
  writer: PrivateExportWriter,
  presign: Presigner,
  names: readonly string[],
  linksName: string
): Promise<string> {
  const links: Record<string, string> = {};
  for (const name of names) {
    links[name] = await presign(
      writer.bucket,
      writer.key(name),
      PRESIGNED_URL_SECONDS
    );
  }
  const put = await writer.put(
    linksName,
    JSON.stringify(
      { expires_in_seconds: PRESIGNED_URL_SECONDS, links },
      null,
      2
    ),
    'application/json'
  );
  return put.key;
}

export async function runProfileSiteExportJob(
  event: ProfileSiteExportEvent,
  context: ProfileSiteExportContext,
  deps: ProfileSiteExportDeps = defaultDeps()
): Promise<ProfileSiteExportResult | ProfileSiteExportLinksResult> {
  await deps.prepareEnvironment();
  const env = deps.env();
  const bucket = bucketOf(context, env);
  if (event.job === LINKS_JOB) {
    return await renewLinks(event.prefix, bucket, deps);
  }
  const startedAt = deps.now();
  const target = replicaTarget(env);
  logger.info(`[EXPORT START] [READ REPLICA ${target.host}]`);
  const privacy = await assertBucketPrivate(deps.s3, bucket);
  const scope: ProfileSiteExportScope = {
    profile: event.profile,
    publicApi: event.publicApi
  };
  const prefix = runPrefix(
    'profile-site-export',
    exportStage(env.NODE_ENV),
    startedAt,
    context.awsRequestId,
    event.profile ? `profile-${event.profile}` : null
  );
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const exporter = await deps.exporter(event.frozenAt);
  const written: ManifestFile[] = [];
  const snapshot = await deps.openSnapshot(target);
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${snapshot.evidence.host}] [AT ${snapshot.evidence.snapshotAt}] [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  let run;
  let gapSeconds = 0;
  try {
    gapSeconds = checkSnapshotTime(
      event.frozenAt,
      Date.parse(snapshot.evidence.snapshotAt),
      event.acceptSnapshotGapMinutes
    ).gapSeconds;
    run = await runProfileCmsExport(
      {
        frozenAt: event.frozenAt,
        profile: event.profile,
        publicApi: event.publicApi
      },
      {
        db: new ProfileCmsExportDb(() => snapshot.executor),
        exporter,
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
        progress: (done, total) => {
          const elapsed = Math.round(
            (deps.now().getTime() - startedAt.getTime()) / 1000
          );
          if (done === 0) {
            logger.info(`[EXPORTING ${total} PROFILES]`);
          } else if (done % PROGRESS_EVERY === 0 || done === total) {
            logger.info(`[PROFILES ${done}/${total}] [${elapsed} S]`);
          }
          const left = context.getRemainingTimeInMillis?.();
          if (left !== undefined && left < DEADLINE_MARGIN_MS && done < total) {
            throw new ProfileSiteExportDeadlineError(done, total, elapsed);
          }
        }
      }
    );
  } catch (error) {
    // The run's own error is the one that matters: a failed close is only
    // logged here.
    await snapshot
      .close()
      .catch((closeError: unknown) =>
        logger.warn(`[SNAPSHOT CLOSE FAILED] ${String(closeError)}`)
      );
    throw error;
  }
  await snapshot.close();
  const putJson = async (name: string, text: string) => {
    const put = await writer.put(name, text, 'application/json');
    written.push({ name, bytes: put.bytes, sha256: put.sha256 });
  };
  await putJson('cms-fields.json', cmsFieldsJson(run));
  await putJson('report.json', reportJson(event.frozenAt, run));
  const usable = run.unavailableProfiles === 0;
  const manifestName = usable ? MANIFEST : UNUSABLE_MANIFEST;
  await writeLinks(
    writer,
    deps.presign,
    [...written.map((file) => file.name), manifestName],
    'links.json'
  );
  const finishedAt = deps.now();
  const expiry = linksExpireAt(finishedAt, await deps.credentialsExpiry());
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    usable,
    scope,
    frozen_at: new Date(event.frozenAt).toISOString(),
    snapshot_at: snapshot.evidence.snapshotAt,
    snapshot_gap_seconds: gapSeconds,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    profiles: run.profiles,
    profiles_with_cms: Object.keys(run.fields).length,
    rebuilt_refused: run.rebuiltRefused,
    unavailable_profiles: run.unavailableProfiles,
    read: { ...snapshot.evidence, read_only: true },
    cms_fields: 'cms-fields.json',
    report: 'report.json',
    links: 'links.json',
    links_expire_at: expiry.at.toISOString(),
    files: written
  };
  // Last: a run that stops early has no manifest, and an unusable one has
  // only manifest.unusable.json.
  const manifestKey = (
    await writer.put(
      manifestName,
      JSON.stringify(manifest, null, 2),
      'application/json'
    )
  ).key;
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
    `[EXPORT DONE] [${prefix}] [${writer.files} OBJECTS] [${writer.bytes} BYTES] [${seconds} S] [USABLE ${usable}] ${exportSummary(run).trim()}`
  );
  return {
    job: JOB,
    bucket,
    prefix,
    manifestKey,
    scope,
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
    snapshotAt: snapshot.evidence.snapshotAt,
    snapshotGapSeconds: gapSeconds,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    seconds,
    linksExpireAt: expiry.at.toISOString(),
    linksLimitedByCredentials: expiry.limitedByCredentials,
    presignedManifestUrl,
    presignedLinksUrl
  };
}

async function readManifest(
  deps: ProfileSiteExportDeps,
  bucket: string,
  key: string
): Promise<Manifest | null> {
  let answer: any;
  try {
    answer = await deps.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw error;
  }
  const manifest = JSON.parse(
    await answer.Body.transformToString('utf8')
  ) as Manifest;
  if (manifest?.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    throw new ProfileSiteExportEventError(`${key} is not a manifest`);
  }
  return manifest;
}

/** Fresh links for an earlier run: only a run with a manifest has them. */
async function renewLinks(
  prefix: string,
  bucket: string,
  deps: ProfileSiteExportDeps
): Promise<ProfileSiteExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  let manifestName = MANIFEST;
  let manifest = await readManifest(deps, bucket, writer.key(MANIFEST));
  if (!manifest) {
    manifestName = UNUSABLE_MANIFEST;
    manifest = await readManifest(deps, bucket, writer.key(UNUSABLE_MANIFEST));
  }
  if (!manifest) {
    throw new ProfileSiteExportEventError(
      `No manifest under ${prefix}: that run didn't finish, or the prefix is wrong`
    );
  }
  const now = deps.now();
  const linksName = `links-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  const linksKey = await writeLinks(
    writer,
    deps.presign,
    [...manifest.files.map((file) => file.name), manifestName],
    linksName
  );
  const expiry = linksExpireAt(now, await deps.credentialsExpiry());
  return {
    job: LINKS_JOB,
    bucket,
    prefix,
    linksKey,
    usable: manifestName === MANIFEST,
    linksExpireAt: expiry.at.toISOString(),
    linksLimitedByCredentials: expiry.limitedByCredentials,
    presignedManifestUrl: await deps.presign(
      bucket,
      writer.key(manifestName),
      PRESIGNED_URL_SECONDS
    ),
    presignedLinksUrl: await deps.presign(
      bucket,
      linksKey,
      PRESIGNED_URL_SECONDS
    )
  };
}
