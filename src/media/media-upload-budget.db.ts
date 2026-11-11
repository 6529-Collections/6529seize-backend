import { MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE, PROFILES_TABLE } from '@/constants';
import { MediaUploadBudgetEntryEntity } from '@/entities/IMediaUploadBudget';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export interface MediaUploadBudgetUsage {
  readonly uploads: number;
  readonly bytes: number;
  /** Creation time of the oldest upload still in the window. */
  readonly oldestAt: number | null;
}

export class MediaUploadBudgetDb extends LazyDbAccessCompatibleService {
  /** Serializes one profile's reservations so the budget cannot be raced. */
  async lockProfile(
    profileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      { wrappedConnection: connection }
    );
  }

  async usageSince(
    profileId: string,
    sinceMs: number,
    connection: ConnectionWrapper<any>
  ): Promise<MediaUploadBudgetUsage> {
    const [row] = await this.db.execute<{
      uploads: number | string;
      bytes: number | string;
      oldest_at: number | string | null;
    }>(
      `select count(*) as uploads,
         coalesce(sum(size_bytes), 0) as bytes,
         min(created_at) as oldest_at
       from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
       where profile_id = :profileId and created_at > :sinceMs`,
      { profileId, sinceMs },
      { wrappedConnection: connection }
    );
    return {
      uploads: Number(row?.uploads ?? 0),
      bytes: Number(row?.bytes ?? 0),
      oldestAt:
        row?.oldest_at === null || row?.oldest_at === undefined
          ? null
          : Number(row.oldest_at)
    };
  }

  async insert(
    entry: MediaUploadBudgetEntryEntity,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `insert into ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
         (id, profile_id, source, created_at, size_bytes, pending_object_key)
       values
         (:id, :profile_id, :source, :created_at, :size_bytes, :pending_object_key)`,
      entry,
      { wrappedConnection: connection }
    );
  }

  async delete(id: string, profileId: string): Promise<void> {
    await this.db.execute(
      `delete from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} where id = :id and profile_id = :profileId`,
      { id, profileId }
    );
  }

  async recordSize(
    id: string,
    profileId: string,
    sizeBytes: number
  ): Promise<void> {
    await this.db.execute(
      `update ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
       set size_bytes = :sizeBytes, pending_object_key = null
       where id = :id and profile_id = :profileId`,
      { id, profileId, sizeBytes }
    );
  }

  /** The profile's single-PUT uploads created before `beforeMs` with no size yet. */
  async findPendingSizes(
    profileId: string,
    sinceMs: number,
    beforeMs: number,
    limit: number
  ): Promise<{ id: string; pending_object_key: string }[]> {
    return this.db.execute<{ id: string; pending_object_key: string }>(
      `select id, pending_object_key from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
       where profile_id = :profileId and created_at > :sinceMs and created_at < :beforeMs
         and pending_object_key is not null
       order by created_at asc
       limit :limit`,
      { profileId, sinceMs, beforeMs, limit }
    );
  }

  async deleteOlderThan(cutoffMs: number, limit: number): Promise<number> {
    const result = await this.db.execute(
      `delete from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} where created_at < :cutoffMs limit :limit`,
      { cutoffMs, limit }
    );
    return this.db.getAffectedRows(result);
  }
}

export const mediaUploadBudgetDb = new MediaUploadBudgetDb(dbSupplier);
