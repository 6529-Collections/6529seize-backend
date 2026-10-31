import { createHash } from 'node:crypto';
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
>;

export type E2eeBlobMigrationTarget = Pick<
  S3E2eeBlobStore,
  'checkBucket' | 'putObject' | 'getObject' | 'deleteBlobs'
> & { readonly config: E2eeBlobS3Config };

export interface E2eeBlobMigrationOptions {
  /** False (the default everywhere) reads and reports only. */
  readonly live: boolean;
  /** Most blobs to examine in this run. */
  readonly limit: number;
}

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
  /** True when more complete MySQL blobs remain after `limit`. */
  more: boolean;
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

async function migrateBlob(
  db: E2eeBlobMigrationDb,
  target: E2eeBlobMigrationTarget,
  blob: E2eeMigratableBlobRow,
  report: E2eeBlobMigrationReport,
  live: boolean
): Promise<void> {
  const chunks = readChunks(blob, await db.getBlobChunkBytes(blob.blob_id));
  if (!live) {
    report.migrated++;
    report.bytes += blob.size;
    return;
  }
  await copyAndVerify(target, blob.blob_id, chunks);
  const outcome = await db.switchBlobToS3(
    blob.blob_id,
    chunks.map((chunk) => chunk.length)
  );
  if (outcome === 'switched') {
    report.migrated++;
    report.bytes += blob.size;
    return;
  }
  if (outcome === 'gone') {
    // Retention deleted the blob meanwhile: remove the copies too.
    await target.deleteBlobs([blob]);
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
 * later run) or expire after 24 hours.
 */
export async function migrateE2eeBlobsToS3(
  deps: {
    readonly db: E2eeBlobMigrationDb;
    readonly target: E2eeBlobMigrationTarget;
  },
  options: E2eeBlobMigrationOptions
): Promise<E2eeBlobMigrationReport> {
  const { db, target } = deps;
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
  let after = '';
  while (report.examined < options.limit) {
    const page = await db.getMigratableBlobs(
      after,
      Math.min(PAGE_SIZE, options.limit - report.examined)
    );
    if (!page.length) return report;
    for (const blob of page) {
      report.examined++;
      after = blob.blob_id;
      try {
        await migrateBlob(db, target, blob, report, options.live);
      } catch (error) {
        report.failures.push({
          blob_id: blob.blob_id,
          reason: (error as Error)?.message ?? 'unknown error'
        });
      }
    }
  }
  report.more = (await db.getMigratableBlobs(after, 1)).length > 0;
  return report;
}
