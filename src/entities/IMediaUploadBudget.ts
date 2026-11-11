import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE } from '@/constants';

export enum MediaUploadBudgetSource {
  DROP = 'drop',
  WAVE = 'wave',
  ATTACHMENT = 'attachment'
}

/**
 * One prepared public media or attachment upload, counted against its
 * profile's rolling upload budget. Rows older than the budget window no
 * longer count and are pruned.
 */
@Entity(MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE)
@Index('idx_media_upload_budget_profile_time', ['profile_id', 'created_at'])
@Index('idx_media_upload_budget_time', ['created_at'])
export class MediaUploadBudgetEntryEntity {
  /** The upload's own id (media upload, upload path or attachment id). */
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 20 })
  readonly source!: MediaUploadBudgetSource;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  /** Stored bytes, once known; null until the upload's size is read. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly size_bytes!: number | null;

  /**
   * Bytes the upload counts while its size is unknown: the largest size
   * allowed for its kind (clients do not declare a size).
   */
  @Column({ type: 'bigint', default: 0 })
  readonly reserved_bytes!: number;

  /**
   * Where the object is stored, while its size is unknown. A completion
   * call records the size; otherwise (no completion call, as for single-PUT
   * uploads, or an unreadable size) a later preparation by the same profile
   * reads it from this key.
   */
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly pending_object_key!: string | null;

  /** When a size read last could not settle this entry; null before that. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly size_checked_at!: number | null;
}
