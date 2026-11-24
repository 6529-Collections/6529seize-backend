import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ClientConfig
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { resolveDbConnectionTargets } from '@/db-iam-auth';
import { Logger } from '@/logging';
import {
  refuseBeforeExportStart,
  runExport,
  WavesExportRunHooks
} from '@/waves-export/cli';
import {
  parseFreezeTime,
  parseWavesExportCommand,
  parseWaveIds,
  ReplicaLagCheckedBy,
  WavesExportCommand
} from '@/waves-export/cli-options';
import { WavesExportStoppedError } from '@/waves-export/waves-export.errors';
import {
  EXPORT_RUNS_FILE,
  forEachLimited,
  WAVES_EXPORT_STAGES,
  WavesExportStage,
  WavesExportSummary
} from '@/waves-export/waves-export.service';
import { buildCommit } from './build-commit';
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
  s3Presigner
} from './chain-exports/private-export-bucket';
import {
  databaseErrorOf,
  networkErrorOf,
  serviceErrorOf
} from './identity-export.handler';

/**
 * The waves export (src/waves-export, `6529 run waves:export`) as a job of
 * this function, invoked by hand again and again until it is done. Each
 * invocation runs the export's stages through the command line's own
 * runExport, one stage per run, with --resume, into /tmp, until its time
 * is up, and keeps everything finished in the private chain exports bucket
 * under `waves-export/<stage>/<run>/`:
 *
 * - `job.json`: the run's inputs, the stages done, and every file uploaded
 *   with its size and sha256. It is the run's state: a file is part of the
 *   export only once job.json lists it, and the next invocation starts from
 *   what it lists;
 * - `raw/...`: the export's OUT/raw, each file uploaded whole after the
 *   export put it in place, and listed in job.json after its upload. The
 *   run log (raw/export_runs.json) is among them, so the export's one
 *   freeze per OUT holds across invocations;
 * - `manifest.json`: written once every stage is done, listing every file;
 * - `links-<time>.json`: presigned links to every file, written by each
 *   invocation of a finished run.
 *
 * With `"action": "upload-link"` an invocation runs no export: it signs one
 * upload link under `waves-export/<stage>/uploads/` instead (see
 * runWavesExportUploadLink).
 */

const logger = Logger.get('WAVES_EXPORT_JOB');

const JOB = 'wavesExport';
const JOB_PREFIX = 'waves-export';
const STATE_FILE = 'job.json';
const STATE_SCHEMA = '6529.waves-export.job.v1';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_SCHEMA = '6529.waves-export.manifest.v1';

/** How long an invocation starts new work: 12 of the function's 15 minutes. */
export const DEFAULT_WORK_SECONDS = 720;
const MIN_WORK_SECONDS = 60;
const MAX_WORK_SECONDS = 840;
/**
 * Left of the function's time after the work, at the least: for the waves
 * still being read when the time is up, and for the uploads after them.
 */
export const FINISH_RESERVE_MS = 120_000;
/** Finished drops files go up this often while a stage runs. */
export const FLUSH_EVERY_MS = 20_000;
/** Uploads at once: each holds its file in memory. */
const UPLOADS_AT_ONCE = 4;
/**
 * Invocations in a row the function's time limit cut off in one stage,
 * with no file finished, before the job refuses to try that stage again.
 */
export const MAX_CUT_OFFS = 2;

/** Names under raw/ the export writes. */
const RAW_NAME =
  /^(?:[A-Za-z0-9_-]+\.json|(?:drops|signed)\/[A-Za-z0-9_-]+\.jsonl\.gz)$/;
const RUN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/**
 * The export's own records of its runs, rewritten by every run of it: the
 * only files under raw/ uploaded again once listed.
 */
const RUN_LOGS: readonly string[] = [EXPORT_RUNS_FILE, 'export.json'];

const EVENT_FIELDS = [
  'job',
  'freezeAt',
  'rehearsal',
  'run',
  'revision',
  'waves',
  'replicaLagCheckedBy',
  'replicaLagCheckNote',
  'workSeconds',
  'concurrency',
  'pageSize',
  'bothMetric',
  'allowFailedWaves',
  'recordsWaveId'
] as const;

/** An event this job can't run: nothing was read or written. */
export class WavesExportJobEventError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WavesExportJobEventError';
  }
}

/** The run's state in the bucket doesn't allow this invocation. */
export class WavesExportJobStateError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WavesExportJobStateError';
  }
}

export interface WavesExportJobEvent {
  readonly job: typeof JOB;
  /** The waves freeze T_w in ms; null for a rehearsal. */
  readonly freezeMs: number | null;
  /** The run's name: required for a rehearsal, optional otherwise. */
  readonly run: string | null;
  readonly revision: string | null;
  /** Only these waves; null for every wave. */
  readonly waveIds: string[] | null;
  /**
   * The person-only replica lag check, exactly as this invocation's event
   * gives it. Never kept in the run's state or taken from anywhere else:
   * each invocation that needs it carries it.
   */
  readonly replicaLagCheckedBy: ReplicaLagCheckedBy | null;
  readonly workSeconds: number;
  readonly concurrency: number | null;
  readonly pageSize: number | null;
  readonly bothMetric: boolean;
  readonly allowFailedWaves: boolean;
  /**
   * The signed records wave, which stays on 6529.io, as the export's
   * --records-wave-id ("none" when 6529.io has none); null to let the
   * export take SIGNED_RECORDS_WAVE_ID from the function's environment.
   * Without either it refuses.
   */
  readonly recordsWaveId: string | null;
}

function fail(message: string): never {
  throw new WavesExportJobEventError(message);
}

function flag(record: Record<string, unknown>, name: string): boolean {
  const value = record[name];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(`${name} must be true or false`);
  return value;
}

function wholeNumber(
  record: Record<string, unknown>,
  name: string,
  min: number,
  max: number
): number | null {
  const value = record[name];
  if (value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** A value a person typed for the lag check: text, not a command line flag. */
function personText(
  record: Record<string, unknown>,
  name: string
): string | null {
  const value = record[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${name} must be text, not empty`);
  }
  if (value.trim().startsWith('--')) {
    fail(`${name} must not start with --`);
  }
  return value.trim();
}

/**
 * The event of the waves export job, `{"job":"wavesExport", ...}`, or null
 * for another job's. A job it can't read throws: a typo never runs with a
 * default.
 */
export function parseWavesExportEvent(
  event: unknown
): WavesExportJobEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  if (record.job !== JOB) return null;
  const unknown = Object.keys(record).filter(
    (key) => !(EVENT_FIELDS as readonly string[]).includes(key)
  );
  if (unknown.length) {
    fail(`Unknown fields: ${unknown.join(', ')}`);
  }
  const rehearsal = flag(record, 'rehearsal');
  if ((record.freezeAt === undefined) === !rehearsal) {
    fail('Give freezeAt, or rehearsal: true for a rehearsal: one of the two');
  }
  let freezeMs: number | null = null;
  if (!rehearsal) {
    const raw = record.freezeAt;
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      fail('freezeAt must be ISO 8601 UTC or 13-digit Unix milliseconds');
    }
    try {
      freezeMs = parseFreezeTime(String(raw));
    } catch (error) {
      fail((error as Error).message);
    }
  }
  const run = record.run;
  if (run !== undefined && (typeof run !== 'string' || !RUN_NAME.test(run))) {
    fail(
      'run must be 1 to 32 lowercase letters, digits or dashes, starting with a letter or digit'
    );
  }
  if (rehearsal && run === undefined) {
    fail(
      'A rehearsal needs run, a name of its own, such as "r1": each name is a new rehearsal, and the same name resumes it'
    );
  }
  const revision = record.revision;
  if (
    revision !== undefined &&
    (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision))
  ) {
    fail("revision must be the exporter's 40-hex git commit");
  }
  let waveIds: string[] | null = null;
  if (record.waves !== undefined) {
    if (
      !Array.isArray(record.waves) ||
      record.waves.some((id) => typeof id !== 'string')
    ) {
      fail('waves must be a list of wave ids');
    }
    waveIds = parseWaveIds(JSON.stringify(record.waves));
    if (!waveIds.length) fail('waves lists no wave');
    if (waveIds.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) {
      fail('A wave id is letters, digits, dashes and underscores only');
    }
    waveIds.sort();
  }
  const recordsWaveId = record.recordsWaveId;
  if (
    recordsWaveId !== undefined &&
    (typeof recordsWaveId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(recordsWaveId))
  ) {
    fail(
      'recordsWaveId must be a wave id: letters, digits, dashes and underscores'
    );
  }
  const person = personText(record, 'replicaLagCheckedBy');
  const note = personText(record, 'replicaLagCheckNote');
  if ((person === null) !== (note === null)) {
    fail(
      'replicaLagCheckedBy (who checked the lag) and replicaLagCheckNote (how) go together'
    );
  }
  if (rehearsal && person !== null) {
    fail(
      'replicaLagCheckedBy and replicaLagCheckNote are for a run after the freeze: a rehearsal only reports the lag'
    );
  }
  return {
    job: JOB,
    freezeMs,
    run: typeof run === 'string' ? run : null,
    revision: typeof revision === 'string' ? revision.toLowerCase() : null,
    waveIds,
    replicaLagCheckedBy:
      person !== null && note !== null ? { person, note } : null,
    workSeconds:
      wholeNumber(record, 'workSeconds', MIN_WORK_SECONDS, MAX_WORK_SECONDS) ??
      DEFAULT_WORK_SECONDS,
    concurrency: wholeNumber(record, 'concurrency', 1, 16),
    pageSize: wholeNumber(record, 'pageSize', 1, 5000),
    bothMetric: flag(record, 'bothMetric'),
    allowFailedWaves: flag(record, 'allowFailedWaves'),
    recordsWaveId: typeof recordsWaveId === 'string' ? recordsWaveId : null
  };
}

/**
 * The job's one action besides the export: a presigned PUT link into the
 * private bucket, for a file made outside 6529.io's account (the drop
 * archives) to go up with no credentials but the link. No export run, no
 * database.
 */
const UPLOAD_LINK_ACTION = 'upload-link';
const UPLOAD_LINK_FIELDS = ['job', 'action', 'name', 'seconds'] as const;
export const UPLOAD_LINK_MIN_SECONDS = 60;
export const UPLOAD_LINK_MAX_SECONDS = 21_600;
export const UPLOAD_LINK_DEFAULT_SECONDS = 7_200;
const UPLOAD_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export interface WavesExportUploadLinkEvent {
  readonly job: typeof JOB;
  readonly action: typeof UPLOAD_LINK_ACTION;
  /** A plain file name: the last part of the key. */
  readonly name: string;
  /** How long the link is signed for. */
  readonly seconds: number;
}

/** What the upload link action returns, and nothing else. */
export interface WavesExportUploadLink {
  readonly putUrl: string;
  readonly key: string;
  /** The latest the link works: it can stop sooner (see s3PutPresigner). */
  readonly expiresAt: string;
}

function isUploadName(name: unknown): name is string {
  return (
    typeof name === 'string' && UPLOAD_NAME.test(name) && !name.includes('..')
  );
}

/**
 * The upload link event: the waves export's job with `action`. Null for
 * an event that isn't one, so the export's own event is read as before.
 */
export function parseWavesExportUploadLinkEvent(
  event: unknown
): WavesExportUploadLinkEvent | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  if (record.job !== JOB || record.action === undefined) return null;
  if (record.action !== UPLOAD_LINK_ACTION) {
    fail(`action must be "${UPLOAD_LINK_ACTION}", the job's one action`);
  }
  const unknown = Object.keys(record).filter(
    (key) => !(UPLOAD_LINK_FIELDS as readonly string[]).includes(key)
  );
  if (unknown.length) {
    fail(
      `Unknown fields for ${UPLOAD_LINK_ACTION}: ${unknown.join(', ')} (it takes name and seconds only)`
    );
  }
  if (!isUploadName(record.name)) {
    fail(
      'name must be a plain file name: 1 to 100 letters, digits, dots, dashes and underscores, with no / and no ..'
    );
  }
  const seconds =
    record.seconds === undefined ? UPLOAD_LINK_DEFAULT_SECONDS : record.seconds;
  if (
    typeof seconds !== 'number' ||
    !Number.isInteger(seconds) ||
    seconds < UPLOAD_LINK_MIN_SECONDS ||
    seconds > UPLOAD_LINK_MAX_SECONDS
  ) {
    fail(
      `seconds must be a whole number from ${UPLOAD_LINK_MIN_SECONDS} to ${UPLOAD_LINK_MAX_SECONDS} (${UPLOAD_LINK_DEFAULT_SECONDS} when not given)`
    );
  }
  return {
    job: JOB,
    action: UPLOAD_LINK_ACTION,
    name: record.name,
    seconds
  };
}

/**
 * `waves-export/<stage>/uploads/<run>-<name>`. The run is this call's own,
 * in a run prefix's form (its UTC time to the millisecond and the start of
 * its request id), so a second link never names an earlier upload's key.
 */
export function uploadKeyOf(
  stage: string,
  at: Date,
  requestId: string | undefined,
  name: string
): string {
  if (!isUploadName(name)) {
    throw new WavesExportJobEventError('Not a plain file name');
  }
  const safeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
  const time = at.toISOString().replace(/[:.]/g, '-');
  const run = (requestId ?? 'local').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `${JOB_PREFIX}/${safeStage}/uploads/${time}-${run}-${name}`;
}

/** The run's folder under the stage: one per freeze, and per name. */
export function runFolder(event: WavesExportJobEvent): string {
  if (event.freezeMs === null) return `rehearsal-${event.run}`;
  const at = new Date(event.freezeMs).toISOString().replace(/[:.]/g, '-');
  return event.run ? `freeze-${at}-${event.run}` : `freeze-${at}`;
}

/** `waves-export/<stage>/<run>/` */
export function runPrefixOf(stage: string, event: WavesExportJobEvent) {
  const safeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
  return `${JOB_PREFIX}/${safeStage}/${runFolder(event)}/`;
}

/**
 * The export's command line for one stage, read by the command line's own
 * parser, so the job runs nothing the CLI would refuse. Its environment
 * defaults (EXPORTER_REVISION, WAVES_FREEZE_AT) are not read: every value
 * comes from the event.
 */
export function stageCommand(
  event: WavesExportJobEvent,
  out: string,
  revision: string,
  stage: WavesExportStage
): WavesExportCommand {
  const args = [
    '--out',
    out,
    '--revision',
    revision,
    '--stages',
    stage,
    '--resume'
  ];
  if (event.freezeMs === null) args.push('--rehearsal');
  else args.push('--freeze-at', String(event.freezeMs));
  if (event.waveIds) args.push('--waves', JSON.stringify(event.waveIds));
  if (event.pageSize !== null) {
    args.push('--page-size', String(event.pageSize));
  }
  if (event.concurrency !== null) {
    args.push('--concurrency', String(event.concurrency));
  }
  if (event.bothMetric) args.push('--both-metric');
  if (event.recordsWaveId) {
    args.push('--records-wave-id', event.recordsWaveId);
  }
  if (event.replicaLagCheckedBy) {
    args.push(
      '--replica-lag-checked-by',
      event.replicaLagCheckedBy.person,
      '--replica-lag-check-note',
      event.replicaLagCheckedBy.note
    );
  }
  const command = parseWavesExportCommand(args, {});
  if (command.command !== 'export') {
    throw new WavesExportJobEventError('Not an export command');
  }
  return command;
}

interface StateFile {
  readonly bytes: number;
  readonly sha256: string;
}

/** job.json. */
export interface WavesExportJobState {
  readonly schema: typeof STATE_SCHEMA;
  readonly prefix: string;
  readonly freeze_at: string | null;
  readonly rehearsal: boolean;
  readonly run: string | null;
  readonly exporter_revision: string;
  readonly waves: string[] | null;
  readonly both_metric: boolean;
  readonly created_at: string;
  updated_at: string;
  invocations: number;
  stages_done: WavesExportStage[];
  /**
   * The stage an invocation was running when it last saved this file; null
   * once it ended on its own. Still set at the next start: the function's
   * time limit cut that invocation off.
   */
  in_flight: {
    readonly stage: WavesExportStage;
    readonly files_at_start: number;
    readonly started_at: string;
  } | null;
  /** Invocations in a row cut off in in_flight's stage, no file finished. */
  cut_offs: number;
  /** Each stage's counts, from the run that finished it. */
  counts: Record<string, Record<string, number>>;
  failed_waves: { readonly id: string; readonly error: string }[];
  /** Every file uploaded under raw/, by its name there. */
  files: Record<string, StateFile>;
  finished_at: string | null;
  manifest_sha256: string | null;
}

export interface WavesExportJobContext {
  readonly invokedFunctionArn?: string;
  readonly awsRequestId?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

export interface WavesExportJobDeps {
  readonly prepareEnvironment: () => Promise<void>;
  /** The environment the export's DB layer reads: process.env. */
  readonly env: () => Record<string, string | undefined>;
  readonly s3: Pick<S3Client, 'send'>;
  readonly presign: Presigner;
  readonly now: () => number;
  /** Where the run's OUT goes: the function's /tmp. */
  readonly tmpDir: () => string;
  readonly buildCommit?: () => string | null;
  /** The command line's runExport. */
  readonly runExport: (
    command: WavesExportCommand,
    hooks: WavesExportRunHooks
  ) => Promise<WavesExportSummary>;
  readonly flushEveryMs?: number;
}

function defaultDeps(): WavesExportJobDeps {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  return {
    prepareEnvironment: async () => {
      const { prepEnvironment } = await import('@/env');
      await prepEnvironment();
    },
    env: () => process.env,
    s3,
    presign: s3Presigner(s3),
    now: () => Date.now(),
    tmpDir: () => os.tmpdir(),
    buildCommit,
    runExport
  };
}

/** Signs a PUT of one key in the bucket for `seconds`. */
export type PutPresigner = (
  bucket: ExportBucket,
  key: string,
  seconds: number
) => Promise<string>;

/**
 * The settings of the client that signs upload links. It signs no checksum
 * unless S3 requires one: by default the SDK signs a checksum of an empty
 * body into a PUT link, and S3 then refuses the file sent to it.
 */
export function putPresignerClientConfig(
  region: string | undefined
): S3ClientConfig {
  return { region, requestChecksumCalculation: 'WHEN_REQUIRED' };
}

/**
 * Presigned PUTs that name the expected owner, which the SDK carries in the
 * link's query: an upload needs nothing but the link. Give it a client made
 * with putPresignerClientConfig. A link lasts no longer than the
 * credentials that signed it.
 */
export function s3PutPresigner(s3: S3Client): PutPresigner {
  return (bucket, key, seconds) =>
    getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket.name,
        Key: key,
        ExpectedBucketOwner: bucket.owner
      }),
      { expiresIn: seconds }
    );
}

export interface WavesExportUploadLinkDeps {
  readonly prepareEnvironment: () => Promise<void>;
  readonly env: () => Record<string, string | undefined>;
  readonly s3: Pick<S3Client, 'send'>;
  readonly presignPut: PutPresigner;
  readonly now: () => number;
}

function defaultUploadLinkDeps(): WavesExportUploadLinkDeps {
  const region = process.env.AWS_REGION;
  return {
    prepareEnvironment: async () => {
      const { prepEnvironment } = await import('@/env');
      await prepEnvironment();
    },
    env: () => process.env,
    s3: new S3Client({ region }),
    presignPut: s3PutPresigner(new S3Client(putPresignerClientConfig(region))),
    now: () => Date.now()
  };
}

/**
 * The upload link: the bucket's privacy checked first, as every invocation
 * does, refusing on any doubt; then one presigned PUT of a key no earlier
 * link named. Logs the key and the expiry, never the link.
 */
export async function runWavesExportUploadLink(
  event: WavesExportUploadLinkEvent,
  context: WavesExportJobContext,
  deps: WavesExportUploadLinkDeps = defaultUploadLinkDeps()
): Promise<WavesExportUploadLink> {
  try {
    await deps.prepareEnvironment();
    const env = deps.env();
    const bucket = exportBucketOf(
      context.invokedFunctionArn,
      env.AWS_REGION ?? ''
    );
    await assertBucketPrivate(deps.s3, bucket);
    const at = new Date(deps.now());
    const key = uploadKeyOf(
      exportStage(env.NODE_ENV),
      at,
      context.awsRequestId,
      event.name
    );
    const putUrl = await deps.presignPut(bucket, key, event.seconds);
    const expiresAt = new Date(
      at.getTime() + event.seconds * 1000
    ).toISOString();
    logger.info(`[UPLOAD LINK] [${key}] [EXPIRES ${expiresAt}]`);
    return { putUrl, key, expiresAt };
  } catch (error) {
    const during = 'making the waves export upload link';
    throw serviceErrorOf(networkErrorOf(fileErrorOf(error), during), during);
  }
}

export interface WavesExportJobLink {
  readonly name: string;
  readonly url: string;
}

interface ResultBase {
  readonly job: typeof JOB;
  readonly bucket: string;
  readonly stage: string;
  readonly prefix: string;
  readonly freezeAt: string | null;
  readonly rehearsal: boolean;
  readonly revision: string;
  readonly buildCommit: string | null;
  readonly invocations: number;
  readonly stagesDone: WavesExportStage[];
  readonly bucketPrivacy: BucketPrivacy;
  readonly seconds: number;
}

/** More to do: invoke again with the same event. */
export interface WavesExportJobProgress extends ResultBase {
  readonly done: false;
  readonly next: {
    /** The stage the next invocation runs first. */
    readonly stage: WavesExportStage;
    /** In the drops stage: waves whose drops are still to read. */
    readonly wavesLeft: number | null;
    readonly waves: number | null;
  };
}

/** Every stage done. */
export interface WavesExportJobDone extends ResultBase {
  readonly done: true;
  readonly files: number;
  readonly bytes: number;
  readonly counts: Record<string, Record<string, number>>;
  readonly failedWaves: { readonly id: string; readonly error: string }[];
  /** False when waves were left out and allowFailedWaves wasn't given. */
  readonly failedWavesAccepted: boolean;
  readonly manifestKey: string;
  readonly manifestSha256: string;
  readonly linksKey: string;
  readonly linksLastAtMost: string;
  /**
   * Presigned GETs of the manifest, the links file (a link per file of the
   * export), export.json and the run log.
   */
  readonly links: WavesExportJobLink[];
  /** Objects under raw/ that job.json doesn't list: not part of the export. */
  readonly unlistedObjects: number;
}

export type WavesExportJobResult = WavesExportJobProgress | WavesExportJobDone;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function revisionOf(event: WavesExportJobEvent, built: string | null): string {
  if (built !== null) {
    if (event.revision !== null && event.revision !== built) {
      throw new WavesExportJobEventError(
        `revision ${event.revision} is not the commit this function was built from (${built}): leave revision out, or give that one`
      );
    }
    return built;
  }
  if (event.revision === null) {
    throw new WavesExportJobEventError(
      "This function's build doesn't record its commit: give revision, the 40-hex commit it was deployed from"
    );
  }
  return event.revision;
}

/**
 * Points the export's DB layer at the read replica for the job's runs, as
 * a person running the CLI points DB_HOST at it, and gives back a function
 * that puts the environment back. The CLI reads through the write-side
 * settings (DB_HOST, or DB_IAM_HOST in IAM mode): they take the reader's
 * values. The export itself then refuses a server that isn't read-only.
 */
export function pointDbAtReader(
  env: Record<string, string | undefined>
): () => void {
  const targets = resolveDbConnectionTargets(env);
  const moves: [string, string][] = targets.write.iam
    ? [
        ['DB_IAM_HOST', 'DB_IAM_HOST_READ'],
        ['DB_IAM_USER', 'DB_IAM_USER_READ']
      ]
    : [
        ['DB_HOST', 'DB_HOST_READ'],
        ['DB_USER', 'DB_USER_READ'],
        ['DB_PASS', 'DB_PASS_READ']
      ];
  const reader = env[moves[0][1]]?.trim();
  const writer = env[moves[0][0]]?.trim();
  if (!reader) {
    throw new WavesExportJobStateError(
      `${moves[0][1]} is not set: the export runs only on the read replica`
    );
  }
  if (writer && reader.toLowerCase() === writer.toLowerCase()) {
    throw new WavesExportJobStateError(
      `${moves[0][1]} is the primary (${moves[0][0]}): the export runs only on the read replica`
    );
  }
  for (const [, from] of moves) {
    if (!env[from]?.trim()) {
      throw new WavesExportJobStateError(
        `${from} is not set: the export runs only on the read replica`
      );
    }
  }
  const saved = moves.map(([to]) => [to, env[to]] as const);
  for (const [to, from] of moves) env[to] = env[from];
  return () => {
    for (const [to, value] of saved) {
      if (value === undefined) delete env[to];
      else env[to] = value;
    }
  };
}

/**
 * A failed file operation in /tmp (it has the file's path, which a network
 * error never has), as its code and call: read as anything else, it would
 * be reported as a failed network call or a failed replica.
 */
export function fileErrorOf(error: unknown): unknown {
  const {
    syscall,
    path: file,
    code
  } = (error ?? {}) as {
    syscall?: unknown;
    path?: unknown;
    code?: unknown;
  };
  if (typeof syscall !== 'string' || typeof file !== 'string') return error;
  logger.error(
    `[FILE OPERATION FAILED] ${String((error as Error)?.message ?? error)}`
  );
  return new WavesExportJobStateError(
    code === 'ENOSPC'
      ? `The function's /tmp is full (ENOSPC, ${syscall}): raise the function's ephemeral storage, then invoke again`
      : `A file operation in the function's /tmp failed: ${String(code)} (${syscall}). Invoke again; the run goes on from its last saved state`
  );
}

function contentTypeOf(name: string): string {
  return name.endsWith('.json') ? 'application/json' : 'application/gzip';
}

function checkRawName(name: string): string {
  if (!RAW_NAME.test(name)) {
    throw new WavesExportJobStateError(
      `${name} is not a name the export writes under raw/`
    );
  }
  return name;
}

/** Runs `work`, flushing every `everyMs` until it settles. */
async function whileFlushing<T>(
  work: Promise<T>,
  everyMs: number,
  flush: () => Promise<void>
): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  const quiet = watched.then(
    () => undefined,
    () => undefined
  );
  while (!settled) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      quiet,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, everyMs);
      })
    ]);
    clearTimeout(timer);
    if (settled) break;
    await flush();
  }
  return watched;
}

/**
 * The run's files between /tmp and the bucket. A file goes up only once the
 * export has put it in place (it writes to .tmp and renames), and job.json
 * lists it only once its upload succeeded. A wave's signed file goes up
 * before its drops file, and the two are listed together once both are up,
 * so a listed drops file always has its signed file listed (when it has
 * one).
 */
class RunFiles {
  /** Drops files listed in job.json: empty in /tmp, so --resume keeps them. */
  private readonly kept = new Set<string>();
  private flushing: Promise<number> = Promise.resolve(0);

  constructor(
    private readonly writer: PrivateExportWriter,
    readonly raw: string,
    private readonly state: WavesExportJobState
  ) {}

  private local(name: string): string {
    return path.join(this.raw, ...checkRawName(name).split('/'));
  }

  /**
   * job.json's files into /tmp: every JSON file, checked against its
   * sha256, and an empty stand-in for each drops file, which the drops
   * stage's --resume reads as a finished wave. Signed files stay in the
   * bucket: the export never reads them.
   */
  async download(): Promise<void> {
    await fs.promises.mkdir(path.join(this.raw, 'drops'), { recursive: true });
    for (const [name, file] of Object.entries(this.state.files)) {
      const target = this.local(name);
      if (name.startsWith('drops/')) {
        await fs.promises.writeFile(target, '');
        this.kept.add(name);
        continue;
      }
      if (name.startsWith('signed/')) continue;
      const read = await this.writer.read(`raw/${name}`);
      if (!read.found) {
        throw new WavesExportJobStateError(
          `${this.writer.key(`raw/${name}`)} is listed in ${STATE_FILE} but S3 answers ${read.reason === 'missing' ? 'that it is missing' : 'with a refusal'}: the run can't go on. Start a new run (another run name)`
        );
      }
      const bytes = Buffer.from(read.text, 'utf8');
      if (
        RUN_LOGS.includes(name) &&
        (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      ) {
        // An invocation cut off after uploading the run's own log, before
        // listing it: the bucket's is newer, and the run log keeps the
        // cut-off run's record. Every other file is uploaded once listed.
        logger.warn(
          `[NEWER ${name} THAN ${STATE_FILE} LISTS] [TAKEN AS IT IS] [${file.sha256} -> ${sha256(bytes)}]`
        );
        this.state.files[name] = {
          bytes: bytes.length,
          sha256: sha256(bytes)
        };
      } else if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new WavesExportJobStateError(
          `${this.writer.key(`raw/${name}`)} is not the file ${STATE_FILE} lists (size or sha256 differ): the run can't go on. Start a new run (another run name)`
        );
      }
      await fs.promises.writeFile(target, bytes);
    }
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.promises.access(file);
      return true;
    } catch {
      return false;
    }
  }

  private async put(name: string, bytes: Buffer): Promise<StateFile> {
    const put = await this.writer.put(
      `raw/${name}`,
      bytes,
      contentTypeOf(name)
    );
    return { bytes: put.bytes, sha256: put.sha256 };
  }

  /** Uploads a file when job.json doesn't list it as it is. */
  private async putChanged(name: string): Promise<boolean> {
    const bytes = await fs.promises.readFile(this.local(name));
    const listed = this.state.files[name];
    if (listed && listed.sha256 === sha256(bytes)) return false;
    this.state.files[name] = await this.put(name, bytes);
    return true;
  }

  /** A finished wave: its signed file (if any), then its drops file. */
  private async putWave(file: string): Promise<void> {
    const dropsName = `drops/${file}`;
    const signedName = `signed/${file}`;
    const signedPath = this.local(signedName);
    const signed = (await this.exists(signedPath))
      ? await this.put(signedName, await fs.promises.readFile(signedPath))
      : null;
    const drops = await this.put(
      dropsName,
      await fs.promises.readFile(this.local(dropsName))
    );
    if (signed) this.state.files[signedName] = signed;
    else delete this.state.files[signedName];
    this.state.files[dropsName] = drops;
    // Listed: /tmp keeps an empty stand-in only.
    await fs.promises.truncate(this.local(dropsName), 0);
    await fs.promises.rm(signedPath, { force: true });
    this.kept.add(dropsName);
  }

  private async finishedWaves(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(this.raw, 'drops'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.jsonl.gz'))
      .filter((name) => !this.kept.has(`drops/${name}`))
      .sort();
  }

  private async topLevelJson(): Promise<string[]> {
    const names = await fs.promises.readdir(this.raw);
    return names.filter((name) => name.endsWith('.json')).sort();
  }

  /**
   * Uploads every finished wave, and the run log unless the export may
   * still be writing it; with `all`, after a stage finished, every other
   * changed file too (the stage's own files and export.json). Returns how
   * many files went up. One flush at a time.
   */
  flush(all: boolean, runLog = true): Promise<number> {
    const next = this.flushing.then(
      () => this.flushNow(all, runLog),
      () => this.flushNow(all, runLog)
    );
    this.flushing = next;
    return next;
  }

  private async flushNow(all: boolean, runLog: boolean): Promise<number> {
    let count = 0;
    if (runLog && (await this.exists(path.join(this.raw, EXPORT_RUNS_FILE)))) {
      if (await this.putChanged(EXPORT_RUNS_FILE)) count++;
    }
    const waves = await this.finishedWaves();
    await forEachLimited(waves, UPLOADS_AT_ONCE, async (file) => {
      await this.putWave(file);
      count++;
    });
    if (all) {
      for (const name of await this.topLevelJson()) {
        if (name === EXPORT_RUNS_FILE) continue;
        if (await this.putChanged(name)) count++;
      }
    }
    return count;
  }

  get listed(): number {
    return Object.keys(this.state.files).length;
  }
}

class RunState {
  constructor(
    private readonly writer: PrivateExportWriter,
    readonly state: WavesExportJobState,
    private readonly now: () => number
  ) {}

  async save(): Promise<void> {
    this.state.updated_at = new Date(this.now()).toISOString();
    await this.writer.put(
      STATE_FILE,
      JSON.stringify(this.state),
      'application/json'
    );
  }
}

function newState(
  prefix: string,
  event: WavesExportJobEvent,
  revision: string,
  nowMs: number
): WavesExportJobState {
  const at = new Date(nowMs).toISOString();
  return {
    schema: STATE_SCHEMA,
    prefix,
    freeze_at: iso(event.freezeMs),
    rehearsal: event.freezeMs === null,
    run: event.run,
    exporter_revision: revision,
    waves: event.waveIds,
    both_metric: event.bothMetric,
    created_at: at,
    updated_at: at,
    invocations: 0,
    stages_done: [],
    in_flight: null,
    cut_offs: 0,
    counts: {},
    failed_waves: [],
    files: {},
    finished_at: null,
    manifest_sha256: null
  };
}

function parseState(text: string, prefix: string): WavesExportJobState {
  let state: WavesExportJobState;
  try {
    state = JSON.parse(text);
  } catch {
    throw new WavesExportJobStateError(
      `${prefix}${STATE_FILE} is not JSON: the run can't go on. Start a new run (another run name)`
    );
  }
  if (
    state?.schema !== STATE_SCHEMA ||
    state.prefix !== prefix ||
    !Array.isArray(state.stages_done) ||
    !state.files ||
    typeof state.files !== 'object'
  ) {
    throw new WavesExportJobStateError(
      `${prefix}${STATE_FILE} is not this run's state: the run can't go on. Start a new run (another run name)`
    );
  }
  Object.keys(state.files).forEach(checkRawName);
  return state;
}

/** Refuses an invocation whose inputs differ from the run's first one's. */
function checkSameRun(
  state: WavesExportJobState,
  event: WavesExportJobEvent,
  revision: string
) {
  const differ: string[] = [];
  const same = (name: string, was: unknown, now: unknown) => {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      differ.push(`${name} ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
    }
  };
  same('freezeAt', state.freeze_at, iso(event.freezeMs));
  same('exporter revision', state.exporter_revision, revision);
  same('waves', state.waves, event.waveIds);
  same('bothMetric', state.both_metric, event.bothMetric);
  if (differ.length) {
    throw new WavesExportJobStateError(
      `${state.prefix} is a run started with other inputs (${differ.join('; ')}). Give the same ones to go on with it, or start a new run with another run name`
    );
  }
}

/**
 * job.json as it is, or a new one when the run hasn't started. A new one is
 * written only if no job.json is there: without list access S3 refuses a
 * read of a missing key, so a refused read alone never starts a run over.
 */
async function loadState(
  writer: PrivateExportWriter,
  event: WavesExportJobEvent,
  revision: string,
  nowMs: number
): Promise<{ state: WavesExportJobState; created: boolean }> {
  const read = await writer.read(STATE_FILE);
  if (read.found) {
    const state = parseState(read.text, writer.prefix);
    checkSameRun(state, event, revision);
    return { state, created: false };
  }
  const state = newState(writer.prefix, event, revision, nowMs);
  try {
    await writer.putOutside(
      writer.key(STATE_FILE),
      JSON.stringify(state),
      'application/json',
      { onlyIfAbsent: true }
    );
  } catch (error) {
    if (!isWriteConflict(error)) throw error;
    throw new WavesExportJobStateError(
      `${writer.key(STATE_FILE)} exists but S3 refused to read it: check that the bucket policy lets the function's role get objects under ${JOB_PREFIX}/`
    );
  }
  return { state, created: true };
}

/** Every object under raw/, with its size. */
async function listRaw(
  s3: Pick<S3Client, 'send'>,
  bucket: ExportBucket,
  prefix: string
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let token: string | undefined;
  do {
    const answer: any = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket.name,
        ExpectedBucketOwner: bucket.owner,
        Prefix: `${prefix}raw/`,
        ContinuationToken: token
      })
    );
    for (const item of answer?.Contents ?? []) {
      found.set(String(item.Key), Number(item.Size));
    }
    token = answer?.IsTruncated ? answer.NextContinuationToken : undefined;
  } while (token);
  return found;
}

function manifestOf(state: WavesExportJobState, stage: string) {
  const files = Object.entries(state.files)
    .map(([name, file]) => ({ name: `raw/${name}`, ...file }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schema: MANIFEST_SCHEMA,
    stage,
    prefix: state.prefix,
    freeze_at: state.freeze_at,
    rehearsal: state.rehearsal,
    exporter_revision: state.exporter_revision,
    waves: state.waves,
    both_metric: state.both_metric,
    stages: state.stages_done,
    counts: state.counts,
    drop_files: files.filter((it) => it.name.startsWith('raw/drops/')).length,
    signed_files: files.filter((it) => it.name.startsWith('raw/signed/'))
      .length,
    failed_waves: state.failed_waves,
    finished_at: state.finished_at,
    files
  };
}

export async function runWavesExportJob(
  event: WavesExportJobEvent,
  context: WavesExportJobContext,
  deps: WavesExportJobDeps = defaultDeps()
): Promise<WavesExportJobResult> {
  try {
    return await runJob(event, context, deps);
  } catch (error) {
    // What the operator's out.json gets: no host from a database or
    // network error, no message from an AWS service's refusal.
    const during = 'running the waves export';
    throw serviceErrorOf(networkErrorOf(fileErrorOf(error), during), during);
  }
}

async function runJob(
  event: WavesExportJobEvent,
  context: WavesExportJobContext,
  deps: WavesExportJobDeps
): Promise<WavesExportJobResult> {
  const startedMs = deps.now();
  await deps.prepareEnvironment();
  const env = deps.env();
  const bucket = exportBucketOf(
    context.invokedFunctionArn,
    env.AWS_REGION ?? ''
  );
  const stage = exportStage(env.NODE_ENV);
  const built = (deps.buildCommit ?? buildCommit)();
  const revision = revisionOf(event, built);
  const privacy = await assertBucketPrivate(deps.s3, bucket);
  // The export's own time check, before the run's state or the database
  // is read.
  refuseBeforeExportStart(event.freezeMs, startedMs);
  const remaining = context.getRemainingTimeInMillis?.();
  const workMs = Math.min(
    event.workSeconds * 1000,
    remaining === undefined ? Infinity : remaining - FINISH_RESERVE_MS
  );
  if (workMs < MIN_WORK_SECONDS * 1000) {
    throw new WavesExportJobStateError(
      `The function's time left (${Math.floor((remaining ?? 0) / 1000)} s) leaves under ${MIN_WORK_SECONDS} s of work after the ${FINISH_RESERVE_MS / 1000} s kept for uploads: give it its 900 s timeout`
    );
  }
  const stopAt = startedMs + workMs;
  const timeIsUp = () => deps.now() >= stopAt;
  const prefix = runPrefixOf(stage, event);
  const writer = new PrivateExportWriter(deps.s3, bucket, prefix);
  const loaded = await loadState(writer, event, revision, startedMs);
  if (loaded.created) {
    // The last invocation lists the bucket: a missing grant shows now.
    await listRaw(deps.s3, bucket, prefix);
  }
  const run = new RunState(writer, loaded.state, deps.now);
  const state = run.state;
  state.invocations++;
  const result = (): ResultBase => ({
    job: JOB,
    bucket: bucket.name,
    stage,
    prefix,
    freezeAt: state.freeze_at,
    rehearsal: state.rehearsal,
    revision,
    buildCommit: built,
    invocations: state.invocations,
    stagesDone: [...state.stages_done],
    bucketPrivacy: privacy,
    seconds: Math.round((deps.now() - startedMs) / 1000)
  });
  if (state.in_flight !== null) {
    // The last invocation didn't end on its own: the time limit cut it off.
    const progressed =
      Object.keys(state.files).length > state.in_flight.files_at_start;
    state.cut_offs = progressed ? 0 : state.cut_offs + 1;
    logger.warn(
      `[CUT OFF] [${prefix}] [STAGE ${state.in_flight.stage}] [${progressed ? 'FILES FINISHED BEFORE IT' : `NO FILE FINISHED, ${state.cut_offs} IN A ROW`}]`
    );
    if (state.cut_offs >= MAX_CUT_OFFS) {
      const cutStage = state.in_flight.stage;
      throw new WavesExportJobStateError(
        `The function's time limit cut off the ${cutStage} stage in ${state.cut_offs} invocations in a row, before any file of it was finished: ` +
          (cutStage === 'drops'
            ? `one wave's drops take longer than an invocation. `
            : `the stage takes longer than an invocation. `) +
          `The job can't finish this run: run the export with the command line (6529 run waves:export) instead`
      );
    }
    state.in_flight = null;
  }
  logger.info(
    `[START] [${prefix}] [${loaded.created ? 'NEW RUN' : `INVOCATION ${state.invocations}`}] [STAGES DONE ${state.stages_done.join(',') || 'NONE'}] [FILES ${Object.keys(state.files).length}] [WORK UNTIL ${new Date(stopAt).toISOString()}] [REVISION ${revision}] [BUILD ${built ?? 'unknown'}]`
  );
  const todo = WAVES_EXPORT_STAGES.filter(
    (it) => !state.stages_done.includes(it)
  );
  if (todo.length) {
    const progress = await runStages(
      event,
      deps,
      writer,
      run,
      revision,
      todo,
      timeIsUp
    );
    if (progress) {
      logger.info(
        `[STOPPED] [${prefix}] [NEXT ${progress.stage}] [STAGES DONE ${state.stages_done.join(',') || 'NONE'}]${progress.wavesLeft === null ? '' : ` [WAVES LEFT ${progress.wavesLeft} OF ${progress.waves}]`}`
      );
      return { ...result(), done: false, next: progress };
    }
  } else {
    await run.save();
  }
  return await finish(event, deps, bucket, stage, writer, run, result);
}

/**
 * Runs the stages left, each as one run of the export with --resume, until
 * the time is up. Returns where the next invocation starts, or null when
 * every stage is done.
 */
async function runStages(
  event: WavesExportJobEvent,
  deps: WavesExportJobDeps,
  writer: PrivateExportWriter,
  run: RunState,
  revision: string,
  todo: readonly WavesExportStage[],
  timeIsUp: () => boolean
): Promise<WavesExportJobProgress['next'] | null> {
  const state = run.state;
  // A warm container keeps an earlier invocation's /tmp: it is cleared, and
  // this invocation works in a folder of its own, out of reach of anything
  // an earlier one left running.
  const base = path.join(deps.tmpDir(), 'waves-export-job');
  await fs.promises.rm(base, { recursive: true, force: true });
  const root = path.join(base, randomUUID());
  const out = path.join(root, 'out');
  const files = new RunFiles(writer, path.join(out, 'raw'), state);
  const restoreEnv = pointDbAtReader(deps.env());
  try {
    await files.download();
    for (const stage of todo) {
      if (timeIsUp()) {
        await run.save();
        return { stage, wavesLeft: null, waves: null };
      }
      const command = stageCommand(event, out, revision, stage);
      state.in_flight = {
        stage,
        files_at_start: files.listed,
        started_at: new Date(deps.now()).toISOString()
      };
      await run.save();
      // The export writes its run log once, as its run starts, before any
      // stage reads; it asks whether to stop before each wave's drops. Once
      // it asks, the log is written and stays as it is until the run ends.
      // A run that failed on one wave can leave its other waves' reads
      // going: once the run has ended, they start no new wave.
      let runLogWritten = false;
      let ended = false;
      const stopBeforeWave = () => {
        runLogWritten = true;
        return ended || timeIsUp();
      };
      let flushError: unknown = null;
      let summary: WavesExportSummary;
      try {
        summary = await whileFlushing(
          // One DB scope for every run in this process: DB services keep
          // the executor they first read.
          deps
            .runExport(command, { stopBeforeWave, keepDbScope: true })
            .finally(() => {
              ended = true;
            }),
          deps.flushEveryMs ?? FLUSH_EVERY_MS,
          async () => {
            try {
              if (await files.flush(false, runLogWritten)) await run.save();
            } catch (error) {
              // Tried again at the stage's end; the export goes on.
              flushError = error;
              logger.warn(
                `[FLUSH FAILED] [${stage}] ${String((error as Error)?.message ?? error)}`
              );
            }
          }
        );
      } catch (error) {
        // Whatever ended the run, the waves it finished are kept.
        const stopped = error instanceof WavesExportStoppedError;
        try {
          await files.flush(false);
          state.in_flight = null;
          await run.save();
        } catch (saveError) {
          // A stop that can't save its progress is a failure. A failed run
          // reports its own error: the next invocation goes on from the
          // last state saved.
          if (stopped) throw saveError;
          logger.warn(
            `[FINISHED WAVES NOT SAVED] [${stage}] ${String((saveError as Error)?.message ?? saveError)}`
          );
        }
        if (error instanceof WavesExportStoppedError) {
          return {
            stage,
            wavesLeft: error.wavesLeft,
            waves: error.waves
          };
        }
        // The export's own refusals pass as they are; the replica's errors
        // as their codes, never a host.
        throw databaseErrorOf(fileErrorOf(error), `running the ${stage} stage`);
      }
      if (flushError) {
        logger.info(`[FLUSH RETRIED AT THE STAGE'S END] [${stage}]`);
      }
      await files.flush(true);
      state.stages_done.push(stage);
      state.counts[stage] = summary.counts;
      state.failed_waves = summary.failed_waves;
      state.in_flight = null;
      state.cut_offs = 0;
      await run.save();
      logger.info(
        `[STAGE DONE] [${stage}] [FILES ${files.listed}] ${JSON.stringify(summary.counts)}`
      );
    }
    return null;
  } finally {
    restoreEnv();
    await fs.promises
      .rm(root, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

/**
 * Every stage done: the manifest (once), then a fresh links file and the
 * links, after checking every listed file is in the bucket at its size.
 */
async function finish(
  event: WavesExportJobEvent,
  deps: WavesExportJobDeps,
  bucket: ExportBucket,
  stage: string,
  writer: PrivateExportWriter,
  run: RunState,
  result: () => ResultBase
): Promise<WavesExportJobDone> {
  const state = run.state;
  const listed = await listRaw(deps.s3, bucket, writer.prefix);
  const missing = Object.entries(state.files).filter(
    ([name, file]) => listed.get(writer.key(`raw/${name}`)) !== file.bytes
  );
  if (missing.length) {
    throw new WavesExportJobStateError(
      `${missing.length === 1 ? `1 file ${STATE_FILE} lists is` : `${missing.length} files ${STATE_FILE} lists are`} missing from the bucket or has another size (raw/${missing[0][0]}${missing.length > 1 ? ' and others' : ''}): objects expire after 30 days. Start a new run (another run name)`
    );
  }
  if (state.manifest_sha256 === null) {
    state.finished_at = new Date(deps.now()).toISOString();
    const put = await writer.put(
      MANIFEST_FILE,
      JSON.stringify(manifestOf(state, stage), null, 2),
      'application/json'
    );
    state.manifest_sha256 = put.sha256;
    await run.save();
  }
  const now = deps.now();
  const presign = (key: string) =>
    deps.presign(bucket, key, PRESIGNED_URL_SECONDS);
  const names = Object.keys(state.files).sort();
  const fileLinks: Record<string, string> = {};
  for (const name of names) {
    fileLinks[`raw/${name}`] = await presign(writer.key(`raw/${name}`));
  }
  const lastAtMost = linksLastAtMost(new Date(now)).toISOString();
  const linksName = `links-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  const linksPut = await writer.put(
    linksName,
    JSON.stringify(
      {
        expires_in_seconds_at_most: PRESIGNED_URL_SECONDS,
        links_last_at_most: lastAtMost,
        manifest: await presign(writer.key(MANIFEST_FILE)),
        files: fileLinks
      },
      null,
      2
    ),
    'application/json'
  );
  const links: WavesExportJobLink[] = [
    { name: MANIFEST_FILE, url: await presign(writer.key(MANIFEST_FILE)) },
    { name: linksName, url: await presign(linksPut.key) }
  ];
  for (const name of ['export.json', EXPORT_RUNS_FILE]) {
    if (state.files[name]) {
      links.push({ name: `raw/${name}`, url: fileLinks[`raw/${name}`] });
    }
  }
  const bytes = Object.values(state.files).reduce(
    (sum, file) => sum + file.bytes,
    0
  );
  const accepted = !state.failed_waves.length || event.allowFailedWaves;
  logger.info(
    `[EXPORT DONE] [${writer.prefix}] [MANIFEST SHA256 ${state.manifest_sha256}] [${names.length} FILES] [${bytes} BYTES] [FAILED WAVES ${state.failed_waves.length}${accepted ? '' : ', NOT ACCEPTED'}]`
  );
  return {
    ...result(),
    done: true,
    files: names.length,
    bytes,
    counts: state.counts,
    failedWaves: state.failed_waves,
    failedWavesAccepted: accepted,
    manifestKey: writer.key(MANIFEST_FILE),
    manifestSha256: state.manifest_sha256!,
    linksKey: linksPut.key,
    linksLastAtMost: lastAtMost,
    links,
    unlistedObjects: Array.from(listed.keys()).filter(
      (key) => !state.files[key.slice(`${writer.prefix}raw/`.length)]
    ).length
  };
}
