import { MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE, PROFILES_TABLE } from '@/constants';
import {
  MediaUploadBudgetEntryEntity,
  MediaUploadBudgetSource
} from '@/entities/IMediaUploadBudget';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export interface MediaUploadBudgetUsage {
  readonly uploads: number;
  /** Recorded sizes, and the reserved bytes of entries without one. */
  readonly bytes: number;
  /** Creation time of the oldest upload still in the window. */
  readonly oldestAt: number | null;
}

export interface PendingMediaUploadSize {
  readonly id: string;
  readonly source: MediaUploadBudgetSource;
  readonly pending_object_key: string;
  readonly created_at: number;
}

/** Bounds every list read and batch delete of this table. */
export const MEDIA_UPLOAD_BUDGET_MAX_ROWS_PER_STATEMENT = 1000;

function boundedLimit(limit: number): number {
  return Math.max(
    1,
    Math.min(MEDIA_UPLOAD_BUDGET_MAX_ROWS_PER_STATEMENT, Math.floor(limit))
  );
}

export class MediaUploadBudgetDb extends LazyDbAccessCompatibleService {
  /**
   * Serializes one profile's reservations so the budget cannot be raced.
   * False when no profiles row has this id: nothing was locked.
   */
  async lockProfile(
    profileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<boolean> {
    const rows = await this.db.execute<{ external_id: string }>(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      { wrappedConnection: connection }
    );
    return rows.length > 0;
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
         coalesce(sum(coalesce(size_bytes, reserved_bytes)), 0) as bytes,
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
         (id, profile_id, source, created_at, size_bytes, reserved_bytes,
          pending_object_key, size_checked_at)
       values
         (:id, :profile_id, :source, :created_at, :size_bytes, :reserved_bytes,
          :pending_object_key, :size_checked_at)`,
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

  /** Settles an entry at its stored size; it is no longer pending. */
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

  /** Keeps an entry pending after a read that could not settle it. */
  async markSizeChecked(
    id: string,
    profileId: string,
    checkedAt: number
  ): Promise<void> {
    await this.db.execute(
      `update ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
       set size_checked_at = :checkedAt
       where id = :id and profile_id = :profileId and pending_object_key is not null`,
      { id, profileId, checkedAt }
    );
  }

  /**
   * The profile's pending entries in the window created before
   * `createdBefore` and not checked since `checkedBefore`, least recently
   * checked first, at most `limit`.
   */
  async findPendingSizes({
    profileId,
    sinceMs,
    createdBefore,
    checkedBefore,
    limit
  }: {
    profileId: string;
    sinceMs: number;
    createdBefore: number;
    checkedBefore: number;
    limit: number;
  }): Promise<PendingMediaUploadSize[]> {
    const rows = await this.db.execute<
      Omit<PendingMediaUploadSize, 'created_at'> & {
        created_at: number | string;
      }
    >(
      `select id, source, pending_object_key, created_at
       from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
       where profile_id = :profileId
         and created_at > :sinceMs and created_at < :createdBefore
         and pending_object_key is not null
         and (size_checked_at is null or size_checked_at < :checkedBefore)
       order by coalesce(size_checked_at, 0) asc, created_at asc
       limit :limit`,
      {
        profileId,
        sinceMs,
        createdBefore,
        checkedBefore,
        limit: boundedLimit(limit)
      }
    );
    return rows.map((row) => ({ ...row, created_at: Number(row.created_at) }));
  }

  async deleteOlderThan(cutoffMs: number, limit: number): Promise<number> {
    const result = await this.db.execute(
      `delete from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} where created_at < :cutoffMs limit :limit`,
      { cutoffMs, limit: boundedLimit(limit) }
    );
    return this.db.getAffectedRows(result);
  }
}

export const mediaUploadBudgetDb = new MediaUploadBudgetDb(dbSupplier);
