import { createHash } from 'node:crypto';
import { E2EE_RETENTION } from '@/e2ee/e2ee.constants';
import { E2eeBlobS3Config } from '@/e2ee/e2ee-blob-store.config';
import { S3E2eeBlobStore } from '@/e2ee/e2ee-blob-store.s3';
import {
  E2eeBlobChunkBytesRow,
  E2eeBlobStorageInventoryRow,
  E2eeDb,
  E2eeMigratableBlobRow
} from '@/e2ee/e2ee.db';

export type E2eeBlobMigrationDb = Pick<
  E2eeDb,
  | 'getBlobStorageInventory'
  | 'getMigratableBlobs'
  | 'getBlobChunkBytes'
  | 'switchBlobToS3'
  | 'getBlob'
>;

export type E2eeBlobMigrationTarget = Pick<
  S3E2eeBlobStore,
  'checkBucket' | 'putObject' | 'getObject' | 'deleteBlobs' | 'location'
> & { readonly config: E2eeBlobS3Config };

export interface E2eeBlobMigrationOptions {
  /** False (the default everywhere) reads and reports only. */
  readonly live: boolean;
  /** Most blobs to examine in this run. */
  readonly limit: number;
  /** Stop starting new blobs after this long (default 10 minutes). */
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
}

/** Leaves room inside the 900 s dbMigrationsLoop timeout for the last blob. */
const DEFAULT_TIME_BUDGET_MS = 10 * 60 * 1000;
/** Blobs this close to their 365-day retention are left to retention. */
const RETENTION_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface E2eeBlobMigrationFailure {
  readonly blob_id: string;
  readonly reason: string;
}

export interface E2eeBlobMigrationReport {
  readonly mode: 'dry-run' | 'live';
  readonly target: E2eeBlobS3Config;
  /** Blobs per storage before this run. */
  readonly inventory: E2eeBlobStorageInventoryRow[];
  /** Complete MySQL blobs examined. */
  examined: number;
  /** Dry run: blobs that would move. Live: blobs copied, verified, switched. */
  migrated: number;
  /** Ciphertext bytes of `migrated`. */
  bytes: number;
  /** Blobs deleted by retention while being copied (their copies removed). */
  vanished: number;
  failures: E2eeBlobMigrationFailure[];
  /** True when more complete MySQL blobs remain (limit or time budget). */
  more: boolean;
}

interface MigrationRun {
  readonly db: E2eeBlobMigrationDb;
  readonly target: E2eeBlobMigrationTarget;
  readonly report: E2eeBlobMigrationReport;
  readonly live: boolean;
  readonly minCreatedAt: number;
}

const PAGE_SIZE = 50;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The chunk bytes of a blob, checked against its row. */
function readChunks(
  blob: E2eeMigratableBlobRow,
  rows: readonly E2eeBlobChunkBytesRow[]
): Buffer[] {
  if (rows.length !== blob.chunk_count) {
    throw new Error(
      `has ${rows.length} chunk rows for chunk_count ${blob.chunk_count}`
    );
  }
  let total = 0;
  const chunks = rows.map((row, position) => {
    if (row.chunk_index !== position) {
      throw new Error(`is missing chunk ${position}`);
    }
    const data = Buffer.from(row.data_b64 ?? '', 'base64');
    if (!data.length || data.length !== row.size) {
      throw new Error(`chunk ${position} bytes do not match its size`);
    }
    total += data.length;
    return data;
  });
  if (total !== blob.size) {
    throw new Error(`chunks add up to ${total}, not ${blob.size}`);
  }
  return chunks;
}

/** Uploads every chunk and reads it back; any hash mismatch aborts. */
async function copyAndVerify(
  target: E2eeBlobMigrationTarget,
  blobId: string,
  chunks: readonly Buffer[]
): Promise<void> {
  for (let index = 0; index < chunks.length; index++) {
    await target.putObject(blobId, index, chunks[index]);
  }
  for (let index = 0; index < chunks.length; index++) {
    const copy = await target.getObject(blobId, index);
    if (!copy) throw new Error(`chunk ${index} is missing after upload`);
    if (
      copy.length !== chunks[index].length ||
      sha256(copy) !== sha256(chunks[index])
    ) {
      throw new Error(`chunk ${index} hash differs after upload`);
    }
  }
}

/**
 * Removes copies of a blob that did not switch, unless its row now points at
 * them (only the migration switches rows, and dbMigrationsLoop runs one
 * invocation at a time). Best effort: a leftover copy is overwritten when
 * the blob is migrated again.
 */
async function removeUnusedCopies(
  run: MigrationRun,
  blob: E2eeMigratableBlobRow
): Promise<void> {
  try {
    const current = await run.db.getBlob(blob.blob_id);
    if (current?.storage === 's3') return;
    await run.target.deleteBlobs([blob]);
  } catch {
    // Reported through the blob's failure; the copy is harmless ciphertext.
  }
}

async function migrateBlob(
  run: MigrationRun,
  blob: E2eeMigratableBlobRow
): Promise<void> {
  const { db, target, report } = run;
  const chunks = readChunks(blob, await db.getBlobChunkBytes(blob.blob_id));
  if (!run.live) {
    report.migrated++;
    report.bytes += blob.size;
    return;
  }
  let outcome: 'switched' | 'gone' | 'changed';
  try {
    await copyAndVerify(target, blob.blob_id, chunks);
    outcome = await db.switchBlobToS3(
      blob.blob_id,
      chunks.map((chunk) => chunk.length),
      target.location,
      run.minCreatedAt
    );
  } catch (error) {
    await removeUnusedCopies(run, blob);
    throw error;
  }
  if (outcome === 'switched') {
    report.migrated++;
    report.bytes += blob.size;
    return;
  }
  await removeUnusedCopies(run, blob);
  if (outcome === 'gone') {
    // Deleted (or about to expire) meanwhile: retention owns it now.
    report.vanished++;
    return;
  }
  throw new Error('changed while it was being copied; run again');
}

/**
 * Moves complete MySQL attachment blobs to S3. For each blob: read the
 * chunks and check them against the row, upload each chunk with a SHA-256
 * checksum, read every chunk back and compare hashes, then (one transaction,
 * re-checked under the row lock) mark the blob `s3` and drop its MySQL
 * bytes. Idempotent: switched blobs are never selected again, and a blob
 * that failed midway is simply copied again (same keys) on the next run.
 * Incomplete uploads are left alone: they either complete (and move on a
 * later run) or expire after 24 hours. Blobs within a day of their 365-day
 * retention are left to retention too. A run stops starting new blobs once
 * its time budget is spent and reports `more`.
 */
export async function migrateE2eeBlobsToS3(
  deps: {
    readonly db: E2eeBlobMigrationDb;
    readonly target: E2eeBlobMigrationTarget;
  },
  options: E2eeBlobMigrationOptions
): Promise<E2eeBlobMigrationReport> {
  const { db, target } = deps;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const minCreatedAt = startedAt - E2EE_RETENTION.blobsMs + RETENTION_MARGIN_MS;
  await target.checkBucket();
  const report: E2eeBlobMigrationReport = {
    mode: options.live ? 'live' : 'dry-run',
    target: target.config,
    inventory: await db.getBlobStorageInventory(),
    examined: 0,
    migrated: 0,
    bytes: 0,
    vanished: 0,
    failures: [],
    more: false
  };
  const run: MigrationRun = {
    db,
    target,
    report,
    live: options.live,
    minCreatedAt
  };
  const withinBudget = () => now() - startedAt < budget;
  let after = '';
  while (report.examined < options.limit && withinBudget()) {
    const page = await db.getMigratableBlobs(
      after,
      Math.min(PAGE_SIZE, options.limit - report.examined),
      minCreatedAt
    );
    if (!page.length) return report;
    for (const blob of page) {
      if (!withinBudget()) break;
      report.examined++;
      after = blob.blob_id;
      try {
        await migrateBlob(run, blob);
      } catch (error) {
        report.failures.push({
          blob_id: blob.blob_id,
          reason: (error as Error)?.message ?? 'unknown error'
        });
      }
    }
  }
  report.more =
    (await db.getMigratableBlobs(after, 1, minCreatedAt)).length > 0;
  return report;
}
