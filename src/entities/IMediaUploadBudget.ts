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
   * A single-PUT upload has no completion call: its public key, until a
   * later preparation by the same profile reads the object's size.
   */
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly pending_object_key!: string | null;
}
