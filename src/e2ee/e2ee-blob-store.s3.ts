import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  E2eeBlobChunkRows,
  E2eeBlobChunkWrite,
  E2eeBlobStorageError,
  E2eeBlobStore,
  E2eeStoredBlobRef
} from '@/e2ee/e2ee-blob-store';
import {
  E2eeBlobS3Config,
  e2eeBlobS3Location
} from '@/e2ee/e2ee-blob-store.config';
import { E2EE_BLOB_ID_PATTERN } from '@/e2ee/e2ee-encoding';
import { ConnectionWrapper } from '@/sql-executor';

export type E2eeBlobS3Client = Pick<S3Client, 'send'>;

/** S3 accepts at most 1000 keys per DeleteObjects request. */
const MAX_DELETE_KEYS = 1000;
/** Chunk rows of S3 blobs keep only the size; the bytes are in S3. */
const NO_BYTES = Buffer.alloc(0);

/**
 * Lambda-friendly client: two attempts of at most 2 s connect plus 8 s
 * request each, so a hung S3 call fails well inside the API's 30 s budget,
 * and region redirects followed in case the API runs in another region than
 * the bucket.
 */
export function createE2eeBlobS3Client(region: string): S3Client {
  return new S3Client({
    region,
    followRegionRedirects: true,
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2_000,
      socketTimeout: 8_000,
      requestTimeout: 8_000,
      throwOnRequestTimeout: true
    })
  });
}

export function e2eeBlobObjectKey(
  prefix: string,
  blobId: string,
  index: number
): string {
  if (!E2EE_BLOB_ID_PATTERN.test(blobId)) {
    throw new Error('Invalid encrypted attachment id for an object key');
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('Invalid encrypted attachment chunk index');
  }
  return `${prefix}/${blobId}/${index}`;
}

function sha256Base64(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

/**
 * GetObject on a missing key: NoSuchKey (the role may list the bucket, so
 * S3 does not answer 403). Any other 404, such as NoSuchBucket, is a storage
 * failure, not a missing chunk.
 */
export function isMissingS3Object(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; Code?: unknown };
  return candidate.name === 'NoSuchKey' || candidate.Code === 'NoSuchKey';
}

function storageError(operation: string, error: unknown): E2eeBlobStorageError {
  const name = (error as Error)?.name ?? 'Error';
  const message = (error as Error)?.message ?? 'unknown';
  return new E2eeBlobStorageError(
    `S3 ${operation} failed: ${name}: ${message}`
  );
}

/**
 * Chunk bytes as private S3 objects at `<prefix>/<blob_id>/<index>`: no ACL
 * (the bucket enforces owner-only objects), SSE-S3 encryption on every
 * write, a SHA-256 checksum S3 verifies on upload and the SDK verifies on
 * download, and never served through a CDN: the API streams each chunk
 * after its membership checks.
 */
export class S3E2eeBlobStore implements E2eeBlobStore {
  readonly storage = 's3' as const;
  readonly location: string;

  constructor(
    readonly config: E2eeBlobS3Config,
    private readonly s3: E2eeBlobS3Client,
    private readonly rows: E2eeBlobChunkRows
  ) {
    this.location = e2eeBlobS3Location(config);
  }

  objectKey(blobId: string, index: number): string {
    return e2eeBlobObjectKey(this.config.prefix, blobId, index);
  }

  /** Read-only reachability check for the bucket (used by the migration). */
  async checkBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (error) {
      throw storageError('HeadBucket', error);
    }
  }

  async putObject(blobId: string, index: number, data: Buffer): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: this.objectKey(blobId, index),
      Body: data,
      ContentLength: data.length,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: sha256Base64(data)
    });
    try {
      await this.s3.send(command);
    } catch (error) {
      throw storageError('PutObject', error);
    }
  }

  /** The object's bytes, or null when it does not exist. */
  async getObject(blobId: string, index: number): Promise<Buffer | null> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: this.objectKey(blobId, index),
      ChecksumMode: 'ENABLED'
    });
    try {
      const response = await this.s3.send(command);
      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isMissingS3Object(error)) return null;
      throw storageError('GetObject', error);
    }
  }

  async putChunk(
    chunk: E2eeBlobChunkWrite,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    // The object is written first: if S3 fails, nothing is recorded. If the
    // transaction fails afterwards, the same key is overwritten on retry and
    // retention deletes it with the blob.
    await this.putObject(chunk.blobId, chunk.index, chunk.data);
    await this.rows.upsertBlobChunk(
      {
        blobId: chunk.blobId,
        index: chunk.index,
        data: NO_BYTES,
        size: chunk.data.length,
        createdAt: chunk.createdAt
      },
      connection
    );
  }

  async getChunk(blobId: string, index: number): Promise<Buffer | null> {
    return this.getObject(blobId, index);
  }

  /**
   * Deletes every possible chunk key of the blobs. Chunk indexes are always
   * below `chunk_count` (the API refuses others before writing), so no
   * listing is needed. Deleting a missing key succeeds, so this is safe to
   * repeat.
   */
  async deleteBlobs(blobs: readonly E2eeStoredBlobRef[]): Promise<void> {
    const keys = blobs.flatMap((blob) =>
      Array.from({ length: Number(blob.chunk_count) }, (_, index) =>
        this.objectKey(blob.blob_id, index)
      )
    );
    for (let start = 0; start < keys.length; start += MAX_DELETE_KEYS) {
      const batch = keys.slice(start, start + MAX_DELETE_KEYS);
      const command = new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
      });
      let response;
      try {
        response = await this.s3.send(command);
      } catch (error) {
        throw storageError('DeleteObjects', error);
      }
      const failed = (response.Errors ?? []).filter(
        (error) => error.Code !== 'NoSuchKey'
      );
      if (failed.length) {
        throw new E2eeBlobStorageError(
          `S3 did not delete ${failed.length} encrypted attachment objects (${failed[0].Code ?? 'unknown error'})`
        );
      }
    }
  }
}
