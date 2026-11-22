import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@/logging';
import { parseCmsFields, parseExtraIds } from '@/identity-export/cli-options';
import { SqlIdentityExportSource } from '@/identity-export/identity-export.db';
import { IdentityExportNotReadyError } from '@/identity-export/identity-export.errors';
import {
  buildIdentityExport,
  IdentityExportDocument
} from '@/identity-export/identity-export.service';
import { InputFile } from '@/identity-export/identity-export.types';
import { jsonDocumentBytes } from '@/identity-export/identity-export.writer';
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

const logger = Logger.get('IDENTITY_EXPORT_JOB');

const JOB = 'identityExport';
const LINKS_JOB = 'identityExportLinks';
const PREFIX_ROOT = 'identity-export/';
/**
 * Where an input may be read from: this job's own prefix (a waves list put
 * there), or a profile site export run (its cms-fields.json).
 */
const INPUT_ROOTS = [PREFIX_ROOT, 'profile-site-export/'] as const;
const EXPORT_FILE = 'identity-export.json';
const SUMMARY_FILE = 'summary.json';
const MANIFEST = 'manifest.json';
/**
 * Not an export the chain's import may use: a rehearsal or timing run, with
 * no freeze to hold the database to.
 */
const UNUSABLE_MANIFEST = 'manifest.unusable.json';
const MANIFEST_SCHEMA = '6529.identity-export.manifest.v1';
/** An input file read from the bucket is never larger than this. */
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/** The snapshot may be at most this long after the freeze, unless acknowledged. */
export const SNAPSHOT_GAP_LIMIT_MINUTES = 90;
/** Below this much time left, the run stops with its progress. */
const DEADLINE_MARGIN_MS = 60_000;

/**
 * An input the job reads: an object of the private chain exports bucket
 * (`{ "key": "identity-export/inputs/waves.json" }`), or the content inline
 * (`{ "inline": [...] }`).
 */
export type IdentityExportInput =
  | { readonly key: string }
  | { readonly inline: unknown };

/**
 * Invoke-only jobs of the dbDumpsDaily function (its schedule sends no
 * `job`):
 * - `identityExport`: the identity export (`6529 run identity:export`) on
 *   the read replica, into the private chain exports bucket under
 *   identity-export/<stage>/, the manifest written last. The event carries
 *   the CLI's options, with the same rules;
 * - `identityExportLinks`: fresh download links for an earlier run.
 */
export type IdentityExportEvent =
  | {
      readonly job: typeof JOB;
      /** Null for a rehearsal (`noFreeze: true`). */
      readonly freezeMs: number | null;
      readonly expectTdhBlock: number | null;
      readonly revision: string;
      readonly bulk: number;
      readonly includeDelegations: boolean;
      /** Null with `noExtraIds: true`. */
      readonly extraIds: IdentityExportInput | null;
      /** Null with `noCmsFields: true`. */
      readonly cmsFields: IdentityExportInput | null;
      readonly acceptOverCredit: number;
      readonly acceptEditsAfterFreeze: number;
      readonly acceptRatingsChangedAfterFreeze: number;
      readonly acceptMissingExtraIds: number;
      /** Accepts a snapshot up to this many minutes after the freeze. */
      readonly acceptSnapshotGapMinutes: number | null;
    }
  | { readonly job: typeof LINKS_JOB; readonly prefix: string };

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
      `Stopped after "${step}" at ${elapsedSeconds} s, with less than ${DEADLINE_MARGIN_MS / 1000} s of the function's time left. Nothing was written: the export needs longer than one invocation.`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportDeadlineError';
  }
}

/**
 * Refuses a snapshot taken before the freeze, or longer after it than the
 * limit (90 minutes) or than the invoker acknowledged.
 */
export function checkSnapshotTime(
  freezeMs: number,
  snapshotAt: number,
  acceptGapMinutes: number | null
): { readonly gapSeconds: number } {
  if (!Number.isFinite(snapshotAt)) {
    throw new IdentityExportSnapshotError("The snapshot's time is unknown");
  }
  const gapSeconds = Math.round((snapshotAt - freezeMs) / 1000);
  if (gapSeconds < 0) {
    throw new IdentityExportSnapshotError(
      `The snapshot (${new Date(snapshotAt).toISOString()}) is before the freeze (${new Date(freezeMs).toISOString()})`
    );
  }
  const limit = Math.max(SNAPSHOT_GAP_LIMIT_MINUTES, acceptGapMinutes ?? 0);
  if (gapSeconds > limit * 60) {
    throw new IdentityExportSnapshotError(
      `The snapshot is ${Math.ceil(gapSeconds / 60)} minutes after the freeze, over the ${limit}-minute limit: it would carry changes made since. Pass acceptSnapshotGapMinutes to accept that.`
    );
  }
  return { gapSeconds };
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
  'acceptOverCredit',
  'acceptEditsAfterFreeze',
  'acceptRatingsChangedAfterFreeze',
  'acceptMissingExtraIds',
  'acceptSnapshotGapMinutes'
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
    const unknownFields = Object.keys(record).filter(
      (key) => key !== 'job' && key !== 'prefix'
    );
    if (unknownFields.length) {
      throw new IdentityExportEventError(
        `Unknown fields: ${unknownFields.join(', ')}`
      );
    }
    const prefix = record.prefix;
    if (
      typeof prefix !== 'string' ||
      !prefix.startsWith(PREFIX_ROOT) ||
      !prefix.endsWith('/') ||
      prefix.includes('..') ||
      !/^[A-Za-z0-9/_.-]+$/.test(prefix)
    ) {
      throw new IdentityExportEventError(
        `prefix must be a run's prefix under ${PREFIX_ROOT}, ending in /`
      );
    }
    return { job: LINKS_JOB, prefix };
  }
  if (record.job !== JOB) return null;
  const unknownFields = Object.keys(record).filter(
    (key) => !(EXPORT_FIELDS as readonly string[]).includes(key)
  );
  if (unknownFields.length) {
    throw new IdentityExportEventError(
      `Unknown fields: ${unknownFields.join(', ')}`
    );
  }
  const noFreeze = flag('noFreeze', record.noFreeze);
  if ((record.freezeAt === undefined) === !noFreeze) {
    throw new IdentityExportEventError(
      'Give freezeAt or noFreeze: true for a rehearsal, one of the two'
    );
  }
  const freezeMs = noFreeze ? null : freezeOf(record.freezeAt);
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
  if (gap !== null && freezeMs === null) {
    throw new IdentityExportEventError(
      'acceptSnapshotGapMinutes is for an export at the freeze'
    );
  }
  const revision = record.revision;
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new IdentityExportEventError(
      "revision must be the exporter's 40-hex git commit"
    );
  }
  return {
    job: JOB,
    freezeMs,
    expectTdhBlock,
    revision: revision.toLowerCase(),
    bulk: wholeNumber('bulk', record.bulk, 2000),
    includeDelegations: !flag('noDelegations', record.noDelegations),
    extraIds: oneOf(record, 'extraIds', 'noExtraIds'),
    cmsFields: oneOf(record, 'cmsFields', 'noCmsFields'),
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
    acceptSnapshotGapMinutes: gap
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
  /** The profile site values' bucket key, `inline`, or null (noCmsFields). */
  readonly cmsFields: string | null;
}

function scopeOf(
  event: Extract<IdentityExportEvent, { job: 'identityExport' }>
): IdentityExportScope {
  const source = (input: IdentityExportInput | null) =>
    input === null ? null : 'key' in input ? input.key : 'inline';
  return {
    freezeAt:
      event.freezeMs === null ? null : new Date(event.freezeMs).toISOString(),
    expectTdhBlock: event.expectTdhBlock,
    bulk: event.bulk,
    includeDelegations: event.includeDelegations,
    extraIds: source(event.extraIds),
    cmsFields: source(event.cmsFields)
  };
}

export interface IdentityExportResult {
  readonly job: typeof JOB;
  readonly bucket: string;
  readonly prefix: string;
  /** manifest.json, or manifest.unusable.json when `usable` is false. */
  readonly manifestKey: string;
  readonly exportKey: string;
  readonly scope: IdentityExportScope;
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
  /** The read replica the export read from (DB_HOST_READ, not DB_HOST). */
  readonly host: string;
  /** The export read in one READ ONLY transaction with a consistent snapshot. */
  readonly readOnly: true;
  readonly evidence: ReadOnlyEvidence;
  readonly bucketPrivacy: BucketPrivacy;
  /** The freeze time, null for a rehearsal. */
  readonly frozenAt: string | null;
  /** The server's clock when the snapshot was taken. */
  readonly snapshotAt: string;
  /** Seconds from the freeze to the snapshot; null for a rehearsal. */
  readonly snapshotGapSeconds: number | null;
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

export interface IdentityExportLinksResult {
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

function defaultDeps(): IdentityExportDeps {
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
    now: () => new Date(),
    credentialsExpiry: () => credentialsExpiry(s3)
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An input's bytes: the bucket object's, or the inline content as JSON. */
async function inputBytes(
  input: IdentityExportInput,
  bucket: string,
  s3: Pick<S3Client, 'send'>
): Promise<Buffer> {
  if ('inline' in input) {
    return Buffer.from(JSON.stringify(input.inline), 'utf8');
  }
  const answer: any = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: input.key })
  );
  const bytes = Buffer.from(await answer.Body.transformToByteArray());
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new IdentityExportEventError(
      `${input.key} is ${bytes.length} bytes: more than ${MAX_INPUT_BYTES}`
    );
  }
  return bytes;
}

function bucketOf(
  context: IdentityExportContext,
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

export async function runIdentityExportJob(
  event: IdentityExportEvent,
  context: IdentityExportContext,
  deps: IdentityExportDeps = defaultDeps()
): Promise<IdentityExportResult | IdentityExportLinksResult> {
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
  // The inputs first: a bad list fails before the database is read.
  const extraIdsBytes = event.extraIds
    ? await inputBytes(event.extraIds, bucket, deps.s3)
    : null;
  const extraProfileIds = extraIdsBytes
    ? parseExtraIds(extraIdsBytes.toString('utf8'))
    : [];
  const cmsBytes = event.cmsFields
    ? await inputBytes(event.cmsFields, bucket, deps.s3)
    : null;
  const cmsFields = cmsBytes
    ? parseCmsFields(cmsBytes.toString('utf8'))
    : undefined;
  const extraIdsFile: InputFile | null = extraIdsBytes
    ? { count: extraProfileIds.length, sha256: sha256(extraIdsBytes) }
    : null;
  const cmsFieldsFile: InputFile | null = cmsBytes
    ? {
        count: Object.keys(cmsFields ?? {}).length,
        sha256: sha256(cmsBytes)
      }
    : null;
  const prefix = runPrefix(
    'identity-export',
    exportStage(env.NODE_ENV),
    startedAt,
    context.awsRequestId,
    event.freezeMs === null ? 'rehearsal' : null
  );
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const scope = scopeOf(event);
  const elapsed = () =>
    Math.round((deps.now().getTime() - startedAt.getTime()) / 1000);
  // Progress, and the deadline: with under a minute left the run stops with
  // the step it reached, before anything is written.
  const step = (name: string) => {
    logger.info(`[${name}] [${elapsed()} S]`);
    const left = context.getRemainingTimeInMillis?.();
    if (left !== undefined && left < DEADLINE_MARGIN_MS) {
      throw new IdentityExportDeadlineError(name, elapsed());
    }
  };
  const snapshot = await deps.openSnapshot(target);
  logger.info(
    `[READ ONLY SNAPSHOT] [HOST ${snapshot.evidence.host}] [AT ${snapshot.evidence.snapshotAt}] [TRANSACTION READ ONLY ${snapshot.evidence.transactionReadOnly}] [SERVER READ ONLY ${snapshot.evidence.serverReadOnly}] [INNODB READ ONLY ${snapshot.evidence.innodbReadOnly}]`
  );
  let document: IdentityExportDocument;
  let gapSeconds: number | null = null;
  try {
    if (event.freezeMs !== null) {
      gapSeconds = checkSnapshotTime(
        event.freezeMs,
        Date.parse(snapshot.evidence.snapshotAt),
        event.acceptSnapshotGapMinutes
      ).gapSeconds;
    }
    document = await buildIdentityExport(
      new SqlIdentityExportSource(
        <T>(sql: string, params?: Record<string, unknown>) =>
          snapshot.executor.execute<T>(sql, params)
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
        extraIdsFile,
        cmsFieldsFile,
        exporterRevision: event.revision,
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
    throw error;
  }
  await snapshot.close();
  step('READ DONE');
  const written: ManifestFile[] = [];
  const putJson = async (name: string, body: Buffer | string) => {
    const put = await writer.put(name, body, 'application/json');
    written.push({ name, bytes: put.bytes, sha256: put.sha256 });
    return put;
  };
  const { identity_sync: _sync, ...file } = document;
  const exportPut = await putJson(EXPORT_FILE, await jsonDocumentBytes(file));
  await putJson(SUMMARY_FILE, JSON.stringify(summaryOf(document), null, 2));
  // Only an export held to the freeze is for the import.
  const usable = event.freezeMs !== null;
  const manifestName = usable ? MANIFEST : UNUSABLE_MANIFEST;
  await writeLinks(
    writer,
    deps.presign,
    [...written.map((it) => it.name), manifestName],
    'links.json'
  );
  const finishedAt = deps.now();
  const expiry = linksExpireAt(finishedAt, await deps.credentialsExpiry());
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    usable,
    ...(usable
      ? {}
      : { unusable_because: 'a rehearsal: no freeze to hold the export to' }),
    scope,
    format: document.format,
    frozen_at: scope.freezeAt,
    snapshot_at: snapshot.evidence.snapshotAt,
    snapshot_gap_seconds: gapSeconds,
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
    links_expire_at: expiry.at.toISOString(),
    files: written
  };
  // Last: a run that stops early has no manifest, and a rehearsal has only
  // manifest.unusable.json.
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
    `[EXPORT DONE] [${prefix}] [${writer.files} OBJECTS] [${writer.bytes} BYTES] [${seconds} S] [USABLE ${usable}] [${document.identities.length} IDENTITIES] [${document.ratings.length} RATINGS]`
  );
  return {
    job: JOB,
    bucket,
    prefix,
    manifestKey,
    exportKey: exportPut.key,
    scope,
    files: writer.files,
    bytes: writer.bytes,
    identities: document.identities.length,
    ratings: document.ratings.length,
    tdhBlock: document.tdh_block,
    usable,
    host: snapshot.evidence.host,
    readOnly: true,
    evidence: snapshot.evidence,
    bucketPrivacy: privacy,
    frozenAt: scope.freezeAt,
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
  deps: IdentityExportDeps,
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
    throw new IdentityExportEventError(`${key} is not a manifest`);
  }
  return manifest;
}

/** Fresh links for an earlier run: only a run with a manifest has them. */
async function renewLinks(
  prefix: string,
  bucket: string,
  deps: IdentityExportDeps
): Promise<IdentityExportLinksResult> {
  await assertBucketPrivate(deps.s3, bucket);
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  let manifestName = MANIFEST;
  let manifest = await readManifest(deps, bucket, writer.key(MANIFEST));
  if (!manifest) {
    manifestName = UNUSABLE_MANIFEST;
    manifest = await readManifest(deps, bucket, writer.key(UNUSABLE_MANIFEST));
  }
  if (!manifest) {
    throw new IdentityExportEventError(
      `No manifest under ${prefix}: that run didn't finish, or the prefix is wrong`
    );
  }
  const now = deps.now();
  const linksName = `links-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  const linksKey = await writeLinks(
    writer,
    deps.presign,
    [...manifest.files.map((it) => it.name), manifestName],
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
