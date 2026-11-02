import { ConnectionWrapper } from '@/sql-executor';

/**
 * Where the ciphertext bytes of an encrypted attachment live. Blob rows and
 * chunk sizes always stay in MySQL, because quota, completion and retention
 * read them under row locks; only the chunk bytes move. Each blob records its
 * storage when it is created, so changing `E2EE_BLOB_STORE` affects new blobs
 * only and existing blobs keep being served from where they are.
 */
export const E2EE_BLOB_STORAGES = ['mysql', 's3'] as const;
export type E2eeBlobStorage = (typeof E2EE_BLOB_STORAGES)[number];

export function isE2eeBlobStorage(value: unknown): value is E2eeBlobStorage {
  return (E2EE_BLOB_STORAGES as readonly unknown[]).includes(value);
}

export interface E2eeBlobChunkWrite {
  readonly blobId: string;
  readonly index: number;
  /** Ciphertext only: the server never holds attachment keys. */
  readonly data: Buffer;
  readonly createdAt: number;
}

/** Enough of a blob row to find all of its chunks. */
export interface E2eeStoredBlobRef {
  readonly blob_id: string;
  readonly chunk_count: number;
}

/** The chunk-row methods every store uses to record chunk sizes. */
export interface E2eeBlobChunkRows {
  upsertBlobChunk(
    input: {
      readonly blobId: string;
      readonly index: number;
      readonly data: Buffer;
      /** Defaults to `data.length`; set when the bytes live elsewhere. */
      readonly size?: number;
      readonly createdAt: number;
    },
    connection: ConnectionWrapper<unknown>
  ): Promise<void>;
  getBlobChunkData(blobId: string, index: number): Promise<string | null>;
}

/** Where a blob's bytes are, as recorded on its row. */
export interface E2eeBlobLocationRef {
  readonly storage?: string | null;
  /** E.g. `s3://<bucket>/<prefix>`; null for MySQL. */
  readonly storage_location?: string | null;
}

/**
 * An external store failed (unreachable, access denied, bucket missing).
 * The API answers 503 for these; database errors are never wrapped in it.
 */
export class E2eeBlobStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeBlobStorageError';
    Object.setPrototypeOf(this, E2eeBlobStorageError.prototype);
  }
}

/**
 * A backend for attachment chunk bytes. Swapping MySQL for S3 (or IPFS
 * later) only needs a new implementation; the routes, quota and retention
 * rules stay the same.
 */
export interface E2eeBlobStore {
  readonly storage: E2eeBlobStorage;
  /**
   * The exact place this store writes, recorded on each blob row so a blob
   * is only ever read or deleted at the place it was written. Null for MySQL.
   */
  readonly location: string | null;
  /**
   * Stores (or replaces) one chunk and records its size row. Called inside
   * the transaction that holds the blob row lock, so concurrent uploads of
   * the same blob are serialized.
   */
  putChunk(
    chunk: E2eeBlobChunkWrite,
    connection: ConnectionWrapper<unknown>
  ): Promise<void>;
  /** The chunk's bytes, or null when the chunk does not exist. */
  getChunk(blobId: string, index: number): Promise<Buffer | null>;
  /**
   * Deletes the bytes of these blobs. The caller deletes the rows afterwards,
   * so a failure here leaves the rows for the next retention pass.
   */
  deleteBlobs(blobs: readonly E2eeStoredBlobRef[]): Promise<void>;
}
