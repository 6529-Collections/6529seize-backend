import { E2eeBlobStorage } from '@/e2ee/e2ee-blob-store';

type Env = Readonly<Record<string, string | undefined>>;

/** A private S3 location for attachment chunks: `<prefix>/<blob_id>/<index>`. */
export interface E2eeBlobS3Config {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
}

export interface E2eeBlobStoreSettings {
  /**
   * Storage for new blobs. Null when the configuration is invalid: uploads
   * are then refused instead of silently falling back to another store.
   */
  readonly writeStorage: E2eeBlobStorage | null;
  /** Null when unset or invalid; S3 blobs then cannot be read or deleted. */
  readonly s3: E2eeBlobS3Config | null;
  /** Why the configuration is unusable (variable names and rules only). */
  readonly problems: readonly string[];
}

const DEFAULT_REGION = 'eu-west-1';
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const MAX_PREFIX_LENGTH = 200;

/** Prefixes the shared drop media ingest bucket expires after three days. */
const EXPIRING_PREFIX_SEGMENTS = new Set([
  'drop-media-ingest',
  'wave-media-ingest'
]);

/**
 * The prefix must name its environment, so a staging deployment can never
 * be pointed at production objects (or the reverse) by a copied setting.
 */
const STAGE_SEGMENT_BY_NODE_ENV: Readonly<Record<string, string>> = {
  production: 'prod',
  development: 'staging',
  local: 'local'
};

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

function parseWriteStorage(raw: string | undefined): {
  readonly storage: E2eeBlobStorage | null;
  readonly problem?: string;
} {
  const value = trimmed(raw).toLowerCase();
  if (!value || value === 'mysql') return { storage: 'mysql' };
  if (value === 's3') return { storage: 's3' };
  return {
    storage: null,
    problem: 'E2EE_BLOB_STORE must be "mysql" or "s3"'
  };
}

function bucketProblem(bucket: string): string | null {
  if (!bucket) return 'E2EE_BLOB_S3_BUCKET is not set';
  if (!BUCKET_PATTERN.test(bucket) || bucket.includes('..')) {
    return 'E2EE_BLOB_S3_BUCKET is not a valid bucket name';
  }
  return null;
}

function prefixProblem(prefix: string, nodeEnv: string | undefined) {
  if (!prefix) return 'E2EE_BLOB_S3_PREFIX is not set';
  const segments = prefix.split('/');
  if (
    prefix.length > MAX_PREFIX_LENGTH ||
    !segments.every((segment) => PREFIX_SEGMENT_PATTERN.test(segment))
  ) {
    return 'E2EE_BLOB_S3_PREFIX must be "/"-separated segments of letters, digits, ".", "_" or "-", each starting with a letter or digit';
  }
  if (segments.some((segment) => EXPIRING_PREFIX_SEGMENTS.has(segment))) {
    return 'E2EE_BLOB_S3_PREFIX must not be inside an expiring ingest prefix';
  }
  const stage = nodeEnv ? STAGE_SEGMENT_BY_NODE_ENV[nodeEnv] : undefined;
  if (stage && !segments.includes(stage)) {
    return `E2EE_BLOB_S3_PREFIX must contain the "${stage}" segment in this environment`;
  }
  return null;
}

/**
 * Validates an S3 location. Used for the API settings and for the migration
 * job, so both write exactly the same keys.
 */
export function parseE2eeBlobS3Config(input: {
  readonly bucket?: string;
  readonly prefix?: string;
  readonly region?: string;
  readonly nodeEnv?: string;
}): { readonly config: E2eeBlobS3Config | null; readonly problems: string[] } {
  const bucket = trimmed(input.bucket);
  const prefix = trimmed(input.prefix).replace(/\/+$/, '');
  const region = trimmed(input.region) || DEFAULT_REGION;
  const problems = [
    bucketProblem(bucket),
    prefixProblem(prefix, input.nodeEnv),
    REGION_PATTERN.test(region) ? null : 'E2EE_BLOB_S3_REGION is not valid'
  ].filter((problem): problem is string => problem !== null);
  return {
    config: problems.length ? null : { bucket, prefix, region },
    problems
  };
}

/**
 * Reads the attachment storage settings:
 * - `E2EE_BLOB_STORE`: `mysql` (default) or `s3`, the storage of new blobs;
 * - `E2EE_BLOB_S3_BUCKET`, `E2EE_BLOB_S3_PREFIX`: required for `s3`;
 * - `E2EE_BLOB_S3_REGION`: the bucket's region (default `AWS_REGION`, then
 *   `eu-west-1`).
 * Anything invalid fails closed: no fallback to MySQL when S3 was asked for.
 */
export function readE2eeBlobStoreSettings(
  env: Env = process.env
): E2eeBlobStoreSettings {
  const write = parseWriteStorage(env.E2EE_BLOB_STORE);
  const problems: string[] = write.problem ? [write.problem] : [];
  const s3Requested =
    write.storage === 's3' ||
    !!trimmed(env.E2EE_BLOB_S3_BUCKET) ||
    !!trimmed(env.E2EE_BLOB_S3_PREFIX);
  let s3: E2eeBlobS3Config | null = null;
  if (s3Requested) {
    const parsed = parseE2eeBlobS3Config({
      bucket: env.E2EE_BLOB_S3_BUCKET,
      prefix: env.E2EE_BLOB_S3_PREFIX,
      region: trimmed(env.E2EE_BLOB_S3_REGION) || env.AWS_REGION,
      nodeEnv: env.NODE_ENV
    });
    s3 = parsed.config;
    problems.push(...parsed.problems);
  }
  return {
    writeStorage: write.storage === 's3' && !s3 ? null : write.storage,
    s3,
    problems
  };
}
