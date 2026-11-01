import {
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  PROFILES_TABLE
} from '@/constants/db-tables';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { E2eeBackupChunkEntity, E2eeBackupEntity } from '@/entities/IE2ee';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export type E2eeBackupRow = E2eeBackupEntity;
export type E2eeBackupChunkRow = E2eeBackupChunkEntity;

type Conn = ConnectionWrapper<unknown>;

/**
 * Metadata of encrypted message-history backups. The chunk bytes live in an
 * E2eeCiphertextStore under `object_key`. Every method that takes a
 * connection runs inside the caller's transaction.
 */
export interface E2eeBackupRepository {
  executeNativeQueriesInTransaction<T>(
    executable: (connection: Conn) => Promise<T>
  ): Promise<T>;
  /** Serializes a profile's backup writes (quota and generation swaps). */
  lockProfile(profileId: string, connection: Conn): Promise<void>;
  getBackup(backupId: string, connection?: Conn): Promise<E2eeBackupRow | null>;
  getActiveBackup(
    profileId: string,
    connection?: Conn
  ): Promise<E2eeBackupRow | null>;
  listProfileBackups(
    profileId: string,
    connection: Conn
  ): Promise<E2eeBackupRow[]>;
  /** Ciphertext bytes of all of the profile's generations. */
  getUsageBytes(profileId: string, connection?: Conn): Promise<number>;
  insertBackup(row: E2eeBackupRow, connection: Conn): Promise<void>;
  activateBackup(
    backupId: string,
    activatedAt: number,
    connection: Conn
  ): Promise<void>;
  insertChunk(row: E2eeBackupChunkRow, connection: Conn): Promise<void>;
  /** Records an appended chunk on its generation (next_seq, count, size). */
  recordChunk(
    input: {
      readonly backupId: string;
      readonly seq: number;
      readonly size: number;
      readonly updatedAt: number;
    },
    connection: Conn
  ): Promise<void>;
  listChunks(
    backupId: string,
    afterSeq: number,
    limit: number
  ): Promise<E2eeBackupChunkRow[]>;
  getChunk(backupId: string, seq: number): Promise<E2eeBackupChunkRow | null>;
  /** Object keys of all chunks of the generations, or those <= throughSeq. */
  listObjectKeys(
    backupIds: readonly string[],
    connection: Conn,
    throughSeq?: number
  ): Promise<string[]>;
  /** Deletes chunks <= throughSeq and recomputes the generation's totals. */
  deleteChunksThrough(
    backupId: string,
    throughSeq: number,
    updatedAt: number,
    connection: Conn
  ): Promise<void>;
  /** Deletes generations and all of their chunk rows. */
  deleteBackups(backupIds: readonly string[], connection: Conn): Promise<void>;
  /** Pending generations created before `cutoff`, oldest first. */
  listStalePending(cutoff: number, limit: number): Promise<E2eeBackupRow[]>;
}

const uniq = (values: readonly string[]) => Array.from(new Set(values));

export class E2eeBackupDb
  extends LazyDbAccessCompatibleService
  implements E2eeBackupRepository
{
  private opts(connection?: Conn): DbQueryOptions {
    return connection
      ? { wrappedConnection: connection }
      : { forcePool: DbPoolName.WRITE };
  }

  private many<T>(
    sql: string,
    params: Record<string, unknown>,
    connection?: Conn
  ): Promise<T[]> {
    return this.db.execute<T>(sql, params, this.opts(connection));
  }

  private async one<T>(
    sql: string,
    params: Record<string, unknown>,
    connection?: Conn
  ): Promise<T | null> {
    const rows = await this.many<T>(sql, params, connection);
    return rows[0] ?? null;
  }

  async lockProfile(profileId: string, connection: Conn): Promise<void> {
    await this.many(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      connection
    );
  }

  getBackup(backupId: string, connection?: Conn) {
    return this.one<E2eeBackupRow>(
      `select * from ${E2EE_BACKUPS_TABLE} where backup_id = :backupId`,
      { backupId },
      connection
    );
  }

  getActiveBackup(profileId: string, connection?: Conn) {
    return this.one<E2eeBackupRow>(
      `select * from ${E2EE_BACKUPS_TABLE}
       where profile_id = :profileId and active = true
       order by activated_at desc limit 1`,
      { profileId },
      connection
    );
  }

  listProfileBackups(profileId: string, connection: Conn) {
    return this.many<E2eeBackupRow>(
      `select * from ${E2EE_BACKUPS_TABLE} where profile_id = :profileId`,
      { profileId },
      connection
    );
  }

  async getUsageBytes(profileId: string, connection?: Conn): Promise<number> {
    const row = await this.one<{ total: number | string | null }>(
      `select coalesce(sum(size), 0) as total from ${E2EE_BACKUPS_TABLE}
       where profile_id = :profileId`,
      { profileId },
      connection
    );
    return Number(row?.total ?? 0);
  }

  async insertBackup(row: E2eeBackupRow, connection: Conn): Promise<void> {
    await this.many(
      `insert into ${E2EE_BACKUPS_TABLE} (
        backup_id, profile_id, envelope, active, next_seq, chunk_count, size,
        created_by_device_key, created_at, updated_at, activated_at
      ) values (
        :backup_id, :profile_id, :envelope, :active, :next_seq, :chunk_count,
        :size, :created_by_device_key, :created_at, :updated_at, :activated_at
      )`,
      { ...row },
      connection
    );
  }

  async activateBackup(
    backupId: string,
    activatedAt: number,
    connection: Conn
  ): Promise<void> {
    await this.many(
      `update ${E2EE_BACKUPS_TABLE}
       set active = true, activated_at = :activatedAt, updated_at = :activatedAt
       where backup_id = :backupId`,
      { backupId, activatedAt },
      connection
    );
  }

  async insertChunk(row: E2eeBackupChunkRow, connection: Conn): Promise<void> {
    await this.many(
      `insert into ${E2EE_BACKUP_CHUNKS_TABLE} (
        backup_id, seq, profile_id, size, object_key, uploader_device_key,
        created_at
      ) values (
        :backup_id, :seq, :profile_id, :size, :object_key,
        :uploader_device_key, :created_at
      )`,
      { ...row },
      connection
    );
  }

  async recordChunk(
    input: {
      readonly backupId: string;
      readonly seq: number;
      readonly size: number;
      readonly updatedAt: number;
    },
    connection: Conn
  ): Promise<void> {
    await this.many(
      `update ${E2EE_BACKUPS_TABLE}
       set next_seq = :nextSeq, chunk_count = chunk_count + 1,
           size = size + :size, updated_at = :updatedAt
       where backup_id = :backupId`,
      {
        backupId: input.backupId,
        nextSeq: input.seq + 1,
        size: input.size,
        updatedAt: input.updatedAt
      },
      connection
    );
  }

  listChunks(backupId: string, afterSeq: number, limit: number) {
    return this.many<E2eeBackupChunkRow>(
      `select * from ${E2EE_BACKUP_CHUNKS_TABLE}
       where backup_id = :backupId and seq > :afterSeq
       order by seq asc limit :limit`,
      { backupId, afterSeq, limit }
    );
  }

  getChunk(backupId: string, seq: number) {
    return this.one<E2eeBackupChunkRow>(
      `select * from ${E2EE_BACKUP_CHUNKS_TABLE}
       where backup_id = :backupId and seq = :seq`,
      { backupId, seq }
    );
  }

  async listObjectKeys(
    backupIds: readonly string[],
    connection: Conn,
    throughSeq?: number
  ): Promise<string[]> {
    if (!backupIds.length) return [];
    const rows = await this.many<{ object_key: string }>(
      `select object_key from ${E2EE_BACKUP_CHUNKS_TABLE}
       where backup_id in (:backupIds)${
         throughSeq === undefined ? '' : ' and seq <= :throughSeq'
       }`,
      { backupIds: uniq(backupIds), throughSeq: throughSeq ?? null },
      connection
    );
    return rows.map((row) => row.object_key);
  }

  async deleteChunksThrough(
    backupId: string,
    throughSeq: number,
    updatedAt: number,
    connection: Conn
  ): Promise<void> {
    await this.many(
      `delete from ${E2EE_BACKUP_CHUNKS_TABLE}
       where backup_id = :backupId and seq <= :throughSeq`,
      { backupId, throughSeq },
      connection
    );
    await this.many(
      `update ${E2EE_BACKUPS_TABLE} b
       set b.chunk_count = (
             select count(*) from ${E2EE_BACKUP_CHUNKS_TABLE} c
             where c.backup_id = :backupId
           ),
           b.size = (
             select coalesce(sum(c.size), 0) from ${E2EE_BACKUP_CHUNKS_TABLE} c
             where c.backup_id = :backupId
           ),
           b.updated_at = :updatedAt
       where b.backup_id = :backupId`,
      { backupId, updatedAt },
      connection
    );
  }

  async deleteBackups(
    backupIds: readonly string[],
    connection: Conn
  ): Promise<void> {
    if (!backupIds.length) return;
    const ids = uniq(backupIds);
    await this.many(
      `delete from ${E2EE_BACKUP_CHUNKS_TABLE} where backup_id in (:ids)`,
      { ids },
      connection
    );
    await this.many(
      `delete from ${E2EE_BACKUPS_TABLE} where backup_id in (:ids)`,
      { ids },
      connection
    );
  }

  listStalePending(cutoff: number, limit: number) {
    return this.many<E2eeBackupRow>(
      `select * from ${E2EE_BACKUPS_TABLE}
       where active = false and created_at < :cutoff
       order by created_at asc limit :limit`,
      { cutoff, limit }
    );
  }
}

export const e2eeBackupDb = new E2eeBackupDb(dbSupplier);
