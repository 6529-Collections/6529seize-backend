import {
  E2eeBlobChunkRows,
  E2eeBlobChunkWrite,
  E2eeBlobStore,
  E2eeStoredBlobRef
} from '@/e2ee/e2ee-blob-store';
import { ConnectionWrapper } from '@/sql-executor';

/** v1 storage: chunk bytes in the `data` column of `e2ee_blob_chunks`. */
export class MysqlE2eeBlobStore implements E2eeBlobStore {
  readonly storage = 'mysql' as const;

  constructor(private readonly rows: E2eeBlobChunkRows) {}

  async putChunk(
    chunk: E2eeBlobChunkWrite,
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    await this.rows.upsertBlobChunk(chunk, connection);
  }

  /**
   * Null when the row is missing or its bytes are empty: chunks are never
   * empty, so empty bytes mean the blob was just migrated elsewhere.
   */
  async getChunk(blobId: string, index: number): Promise<Buffer | null> {
    const data = await this.rows.getBlobChunkData(blobId, index);
    return data ? Buffer.from(data, 'base64') : null;
  }

  /** The bytes are deleted together with the chunk rows. */
  async deleteBlobs(_blobs: readonly E2eeStoredBlobRef[]): Promise<void> {
    return;
  }
}
