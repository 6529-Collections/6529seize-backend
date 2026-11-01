import { E2EE_CIPHERTEXT_OBJECTS_TABLE } from '@/constants/db-tables';
import { DbPoolName } from '@/db-query.options';
import { fromMysqlBase64 } from '@/e2ee/e2ee-encoding';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

/**
 * Opaque client ciphertext addressed by key. The server never interprets the
 * bytes. Writes happen outside database transactions so an object-store
 * implementation (S3) can replace the MySQL one without changing callers:
 * callers write the object before committing the metadata that references
 * it, and delete objects only after the metadata delete committed.
 */
export interface E2eeCiphertextStore {
  put(key: string, data: Buffer): Promise<void>;
  /** Null when no object has the key. */
  get(key: string): Promise<Buffer | null>;
  deleteMany(keys: readonly string[]): Promise<void>;
}

const DELETE_BATCH = 100;

/** MySQL implementation (used until the S3 store lands). */
export class MysqlE2eeCiphertextStore
  extends LazyDbAccessCompatibleService
  implements E2eeCiphertextStore
{
  async put(key: string, data: Buffer): Promise<void> {
    await this.db.execute(
      `insert into ${E2EE_CIPHERTEXT_OBJECTS_TABLE} (object_key, data, created_at)
       values (:key, :data, :createdAt)
       on duplicate key update data = values(data)`,
      { key, data, createdAt: Date.now() },
      { forcePool: DbPoolName.WRITE }
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const rows = await this.db.execute<{ data_b64: string }>(
      `select to_base64(data) as data_b64 from ${E2EE_CIPHERTEXT_OBJECTS_TABLE}
       where object_key = :key`,
      { key },
      { forcePool: DbPoolName.WRITE }
    );
    const row = rows[0];
    if (!row) return null;
    return Buffer.from(fromMysqlBase64(row.data_b64) ?? '', 'base64');
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    const unique = Array.from(new Set(keys));
    for (let start = 0; start < unique.length; start += DELETE_BATCH) {
      await this.db.execute(
        `delete from ${E2EE_CIPHERTEXT_OBJECTS_TABLE} where object_key in (:keys)`,
        { keys: unique.slice(start, start + DELETE_BATCH) },
        { forcePool: DbPoolName.WRITE }
      );
    }
  }
}

export const e2eeCiphertextStore: E2eeCiphertextStore =
  new MysqlE2eeCiphertextStore(dbSupplier);
