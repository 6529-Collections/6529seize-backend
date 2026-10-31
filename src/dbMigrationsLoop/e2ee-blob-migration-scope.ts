import {
  E2eeBlobS3Config,
  parseE2eeBlobS3Config
} from '@/e2ee/e2ee-blob-store.config';
import {
  createE2eeBlobS3Client,
  E2eeBlobS3Client,
  S3E2eeBlobStore
} from '@/e2ee/e2ee-blob-store.s3';
import {
  E2eeBlobMigrationReport,
  migrateE2eeBlobsToS3
} from '@/e2ee/e2ee-blob-migration';
import { e2eeDb, E2eeDb } from '@/e2ee/e2ee.db';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Operator-only `dbMigrationsLoop` scope that copies MySQL attachment chunks
 * to S3 (never run by the deploy workflow or the schedule):
 *
 *   {"schema_scope": "e2ee-blobs-to-s3"}                dry run
 *   {"schema_scope": "e2ee-blobs-to-s3", "live": true}  copy and switch
 *
 * Optional `limit` (blobs per run, default 200, at most 2000) and `bucket`,
 * `prefix`, `region` (default: the E2EE_BLOB_S3_* settings). The location
 * must name this environment's stage, as the API requires.
 */
export const E2EE_BLOB_MIGRATION_SCOPE = 'e2ee-blobs-to-s3';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

export interface E2eeBlobMigrationRequest {
  readonly live: boolean;
  readonly limit: number;
  readonly s3: E2eeBlobS3Config;
}

function optionalString(
  event: Record<string, unknown>,
  name: string
): string | undefined {
  const value = event[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

/**
 * A live run may not copy to another location than the one this Lambda's
 * own E2EE_BLOB_S3_* settings name (when it has valid ones). Blobs record
 * their location, so a mismatch could not mislead the API, but it would
 * leave migrated blobs unavailable until the settings are aligned.
 */
function assertSameAsConfigured(target: E2eeBlobS3Config, env: Env): void {
  const configured = parseE2eeBlobS3Config({
    bucket: env.E2EE_BLOB_S3_BUCKET,
    prefix: env.E2EE_BLOB_S3_PREFIX,
    region: env.E2EE_BLOB_S3_REGION?.trim() || env.AWS_REGION,
    nodeEnv: env.NODE_ENV
  }).config;
  if (
    configured &&
    (configured.bucket !== target.bucket || configured.prefix !== target.prefix)
  ) {
    throw new Error(
      'A live run must use the configured E2EE_BLOB_S3_BUCKET and E2EE_BLOB_S3_PREFIX'
    );
  }
}

/** Parse after secrets are loaded: NODE_ENV and the defaults come from them. */
export function parseE2eeBlobMigrationRequest(
  event: Record<string, unknown>,
  env: Env = process.env
): E2eeBlobMigrationRequest {
  if (event.live !== undefined && typeof event.live !== 'boolean') {
    throw new Error('live must be true or false');
  }
  const parsed = parseE2eeBlobS3Config({
    bucket: optionalString(event, 'bucket') ?? env.E2EE_BLOB_S3_BUCKET,
    prefix: optionalString(event, 'prefix') ?? env.E2EE_BLOB_S3_PREFIX,
    region:
      optionalString(event, 'region') ??
      (env.E2EE_BLOB_S3_REGION?.trim() || env.AWS_REGION),
    nodeEnv: env.NODE_ENV
  });
  if (!parsed.config) throw new Error(parsed.problems.join('; '));
  if (event.live === true) assertSameAsConfigured(parsed.config, env);
  return {
    live: event.live === true,
    limit: parseLimit(event.limit),
    s3: parsed.config
  };
}

export async function runE2eeBlobMigrationScope(
  event: Record<string, unknown>,
  deps: {
    readonly db: E2eeDb;
    readonly s3Client: (region: string) => E2eeBlobS3Client;
    readonly env?: Env;
  } = { db: e2eeDb, s3Client: createE2eeBlobS3Client }
): Promise<E2eeBlobMigrationReport> {
  const request = parseE2eeBlobMigrationRequest(event, deps.env);
  const target = new S3E2eeBlobStore(
    request.s3,
    deps.s3Client(request.s3.region),
    deps.db
  );
  return migrateE2eeBlobsToS3(
    { db: deps.db, target },
    { live: request.live, limit: request.limit }
  );
}
