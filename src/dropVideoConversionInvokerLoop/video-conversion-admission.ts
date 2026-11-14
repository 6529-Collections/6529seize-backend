import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { BACKFILL_RUN_METADATA_KEY } from '../media/metadata-backfill/backfill-markers';

const GIB = 1024 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const LEDGER_PREFIX = '_video-conversion-ledger/v1/';
const LEDGER_WRITE_ATTEMPTS = 3;
const S3_TIMEOUT_MS = 5000;

export interface VideoConversionLimits {
  /** Objects larger than this are not converted. */
  readonly maxBytes: number;
  /** Conversion jobs started per object key within `windowMs`. */
  readonly maxJobsPerKey: number;
  readonly windowMs: number;
}

export const DEFAULT_VIDEO_CONVERSION_LIMITS: VideoConversionLimits = {
  maxBytes: 2 * GIB,
  maxJobsPerKey: 3,
  windowMs: 24 * HOUR_MS
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Deployment settings, with generous defaults for real uploads. */
export function videoConversionLimitsFrom(
  source: Record<string, string | undefined>
): VideoConversionLimits {
  return {
    maxBytes: positiveInteger(
      source.DROP_VIDEO_CONVERSION_MAX_BYTES,
      DEFAULT_VIDEO_CONVERSION_LIMITS.maxBytes
    ),
    maxJobsPerKey: positiveInteger(
      source.DROP_VIDEO_CONVERSION_MAX_JOBS_PER_KEY,
      DEFAULT_VIDEO_CONVERSION_LIMITS.maxJobsPerKey
    ),
    windowMs:
      positiveInteger(
        source.DROP_VIDEO_CONVERSION_JOB_WINDOW_HOURS,
        DEFAULT_VIDEO_CONVERSION_LIMITS.windowMs / HOUR_MS
      ) * HOUR_MS
  };
}

export type VideoConversionDecision =
  | { readonly convert: true; readonly etag: string | null }
  | {
      readonly convert: false;
      readonly reason:
        | 'missing'
        | 'superseded'
        | 'too_large'
        | 'unknown_size'
        | 'duplicate'
        | 'job_cap'
        | 'backfill_rewrite';
      readonly detail?: Record<string, unknown>;
    };

interface LedgerJob {
  readonly etag: string;
  readonly event: string | null;
  readonly at: number;
}

interface Ledger {
  readonly jobs: readonly LedgerJob[];
  /** The ledger object's own ETag; null when it does not exist yet. */
  readonly version: string | null;
}

function unquote(etag: string | undefined | null): string | null {
  if (!etag) return null;
  return etag.replace(/^"|"$/g, '');
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return (
    name === 'NotFound' || name === 'NoSuchKey' || httpStatus(error) === 404
  );
}

function isConditionalWriteConflict(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = httpStatus(error);
  return (
    name === 'PreconditionFailed' ||
    name === 'ConditionalRequestConflict' ||
    status === 412 ||
    status === 409
  );
}

/** One small JSON object per video key records the jobs started for it. */
export function videoConversionLedgerKey(key: string): string {
  return `${LEDGER_PREFIX}${createHash('sha256').update(key).digest('hex')}.json`;
}

function parseJobs(body: string): LedgerJob[] {
  try {
    const parsed = JSON.parse(body) as { jobs?: unknown };
    if (!Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.filter(
      (job): job is LedgerJob =>
        !!job &&
        typeof job.etag === 'string' &&
        typeof job.at === 'number' &&
        (job.event === null || typeof job.event === 'string')
    );
  } catch {
    // An unreadable ledger is replaced by the next conditional write.
    return [];
  }
}

/**
 * Bounds MediaConvert work per uploaded object before a job is created:
 * - the current object (HEAD) must exist, still be the version this event
 *   announced, and be no larger than `maxBytes`;
 * - an object the chat media metadata backfill rewrote in place is not
 *   converted again: it holds the same frames, and its renditions stay;
 * - one job per object version (key + ETag): a repeated PUT of identical
 *   bytes, or another event for it, starts nothing (a redelivery of the same
 *   event may retry its own job);
 * - at most `maxJobsPerKey` jobs per key within `windowMs`, counted in a
 *   ledger object updated only by conditional writes, so concurrent events
 *   for one key cannot both pass.
 */
export async function admitVideoConversion({
  s3,
  bucket,
  key,
  eventEtag,
  eventSize,
  eventId,
  limits,
  now
}: {
  s3: S3Client;
  bucket: string;
  key: string;
  eventEtag: string | null;
  eventSize: number | null;
  eventId: string | null;
  limits: VideoConversionLimits;
  now: number;
}): Promise<VideoConversionDecision> {
  let current: {
    etag: string | null;
    size: number | null;
    backfilled: boolean;
  } | null = null;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(S3_TIMEOUT_MS) }
    );
    current = {
      etag: unquote(head.ETag),
      size: typeof head.ContentLength === 'number' ? head.ContentLength : null,
      backfilled: !!head.Metadata?.[BACKFILL_RUN_METADATA_KEY]
    };
  } catch (error) {
    if (isNotFound(error)) return { convert: false, reason: 'missing' };
    // Without list permission S3 answers a missing key with 403; fall back
    // to what the event reported for this write.
  }
  const announced = unquote(eventEtag);
  if (current?.etag && announced && current.etag !== announced) {
    // A later write replaced this version; its own event converts it.
    return { convert: false, reason: 'superseded' };
  }
  if (current?.backfilled)
    return { convert: false, reason: 'backfill_rewrite' };
  const size = current?.size ?? eventSize;
  if (size === null) return { convert: false, reason: 'unknown_size' };
  if (size > limits.maxBytes) {
    return {
      convert: false,
      reason: 'too_large',
      detail: { size, max_bytes: limits.maxBytes }
    };
  }
  const etag = current?.etag ?? announced;
  if (!etag) return { convert: true, etag: null };
  return recordJob({ s3, bucket, key, etag, eventId, limits, now });
}

async function recordJob({
  s3,
  bucket,
  key,
  etag,
  eventId,
  limits,
  now
}: {
  s3: S3Client;
  bucket: string;
  key: string;
  etag: string;
  eventId: string | null;
  limits: VideoConversionLimits;
  now: number;
}): Promise<VideoConversionDecision> {
  const ledgerKey = videoConversionLedgerKey(key);
  for (let attempt = 1; ; attempt++) {
    const ledger = await readLedger(s3, bucket, ledgerKey);
    const sameVersion = ledger.jobs.filter((job) => job.etag === etag);
    if (sameVersion.length) {
      return eventId !== null &&
        sameVersion.some((job) => job.event === eventId)
        ? { convert: true, etag }
        : { convert: false, reason: 'duplicate' };
    }
    const recent = ledger.jobs.filter((job) => job.at > now - limits.windowMs);
    if (recent.length >= limits.maxJobsPerKey) {
      return {
        convert: false,
        reason: 'job_cap',
        detail: {
          jobs_in_window: recent.length,
          max_jobs_per_key: limits.maxJobsPerKey
        }
      };
    }
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: ledgerKey,
          Body: JSON.stringify({
            jobs: [...recent, { etag, event: eventId, at: now }]
          }),
          ContentType: 'application/json',
          ...(ledger.version
            ? { IfMatch: `"${ledger.version}"` }
            : { IfNoneMatch: '*' })
        }),
        { abortSignal: AbortSignal.timeout(S3_TIMEOUT_MS) }
      );
      return { convert: true, etag };
    } catch (error) {
      if (
        !isConditionalWriteConflict(error) ||
        attempt >= LEDGER_WRITE_ATTEMPTS
      )
        throw error;
      // Another event for this key changed the ledger: decide again.
    }
  }
}

async function readLedger(
  s3: S3Client,
  bucket: string,
  ledgerKey: string
): Promise<Ledger> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: ledgerKey }),
      { abortSignal: AbortSignal.timeout(S3_TIMEOUT_MS) }
    );
    const body = (await response.Body?.transformToString()) ?? '';
    return { jobs: parseJobs(body), version: unquote(response.ETag) };
  } catch (error) {
    // A missing ledger reads as 404, or as 403 without list permission. The
    // conditional create below fails if it exists after all.
    if (isNotFound(error) || httpStatus(error) === 403)
      return { jobs: [], version: null };
    throw error;
  }
}
