import { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
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

/** One file of the export is never larger than the store's largest file. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const JOB = 'profileSiteExport';
const LINKS_JOB = 'profileSiteExportLinks';
const PREFIX_ROOT = 'profile-site-export/';
const MANIFEST = 'manifest.json';
const MANIFEST_SCHEMA = '6529.profile-site-export.manifest.v1';

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
    }
  | { readonly job: typeof LINKS_JOB; readonly prefix: string };

export class ProfileSiteExportEventError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ProfileSiteExportEventError';
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
  only(record, ['job', 'frozenAt', 'profile', 'publicApi']);
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
  return {
    job: JOB,
    frozenAt: frozenAtOf(record.frozenAt),
    profile,
    publicApi
  };
}

export interface ProfileSiteExportResult {
  readonly job: typeof JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly manifestKey: string;
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
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
  readonly linksExpireAt: string;
  readonly presignedManifestUrl: string;
  /** links.json: a presigned link for every object of the run. */
  readonly presignedLinksUrl: string;
}

export interface ProfileSiteExportLinksResult {
  readonly job: typeof LINKS_JOB;
  readonly bucket: string;
  readonly prefix: string;
  readonly linksKey: string;
  readonly linksExpireAt: string;
  readonly presignedManifestUrl: string;
  readonly presignedLinksUrl: string;
}

export interface ProfileSiteExportContext {
  readonly invokedFunctionArn?: string;
  readonly awsRequestId?: string;
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
}

interface ManifestFile {
  readonly name: string;
  readonly bytes: number;
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
    now: () => new Date()
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

/** Presigns every object and writes links.json; returns its key. */
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
  return await writer.put(
    linksName,
    JSON.stringify(
      { expires_in_seconds: PRESIGNED_URL_SECONDS, links },
      null,
      2
    ),
    'application/json'
  );
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
  const prefix = runPrefix(
    'profile-site-export',
    env.NODE_ENV,
    startedAt,
    context.awsRequestId
  );
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const exporter = await deps.exporter(event.frozenAt);
  const written: ManifestFile[] = [];
  const snapshot = await deps.openSnapshot(target);
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${snapshot.evidence.host}] [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  let run;
  try {
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
            await writer.put(name, bytes, 'application/octet-stream');
            written.push({ name, bytes: bytes.length });
          }
        },
        getJson: deps.getJson
      }
    );
  } finally {
    await snapshot.close();
  }
  const fields = cmsFieldsJson(run);
  await writer.put('cms-fields.json', fields, 'application/json');
  written.push({ name: 'cms-fields.json', bytes: Buffer.byteLength(fields) });
  const report = reportJson(event.frozenAt, run);
  await writer.put('report.json', report, 'application/json');
  written.push({ name: 'report.json', bytes: Buffer.byteLength(report) });
  await writeLinks(
    writer,
    deps.presign,
    [...written.map((file) => file.name), MANIFEST],
    'links.json'
  );
  const finishedAt = deps.now();
  const usable = run.unavailableProfiles === 0;
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    frozen_at: new Date(event.frozenAt).toISOString(),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    profiles: run.profiles,
    profiles_with_cms: Object.keys(run.fields).length,
    usable,
    rebuilt_refused: run.rebuiltRefused,
    unavailable_profiles: run.unavailableProfiles,
    read: { ...snapshot.evidence, read_only: true },
    cms_fields: 'cms-fields.json',
    report: 'report.json',
    links: 'links.json',
    files: written
  };
  // Last: a run that stops early has no manifest.
  const manifestKey = await writer.put(
    MANIFEST,
    JSON.stringify(manifest, null, 2),
    'application/json'
  );
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
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    seconds,
    linksExpireAt: new Date(
      finishedAt.getTime() + PRESIGNED_URL_SECONDS * 1000
    ).toISOString(),
    presignedManifestUrl,
    presignedLinksUrl
  };
}

/** Fresh links for an earlier run: only a run with a manifest has them. */
async function renewLinks(
  prefix: string,
  bucket: string,
  deps: ProfileSiteExportDeps
): Promise<ProfileSiteExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const answer: any = await deps.s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: writer.key(MANIFEST) })
  );
  const manifest = JSON.parse(
    await answer.Body.transformToString('utf8')
  ) as Manifest;
  if (manifest?.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    throw new ProfileSiteExportEventError(
      `${prefix}${MANIFEST} is not a manifest`
    );
  }
  const now = deps.now();
  const linksName = `links-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  const linksKey = await writeLinks(
    writer,
    deps.presign,
    [...manifest.files.map((file) => file.name), MANIFEST],
    linksName
  );
  return {
    job: LINKS_JOB,
    bucket,
    prefix,
    linksKey,
    linksExpireAt: new Date(
      now.getTime() + PRESIGNED_URL_SECONDS * 1000
    ).toISOString(),
    presignedManifestUrl: await deps.presign(
      bucket,
      writer.key(MANIFEST),
      PRESIGNED_URL_SECONDS
    ),
    presignedLinksUrl: await deps.presign(
      bucket,
      linksKey,
      PRESIGNED_URL_SECONDS
    )
  };
}
