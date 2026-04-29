import { ATTACHMENTS_TABLE, DROP_ATTACHMENTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum AttachmentKind {
  PDF = 'PDF',
  CSV = 'CSV'
}

export enum AttachmentStatus {
  UPLOADING = 'UPLOADING',
  VERIFYING = 'VERIFYING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  BLOCKED = 'BLOCKED',
  FAILED = 'FAILED'
}

@Entity(ATTACHMENTS_TABLE)
@Index('idx_attachments_owner_status', ['owner_profile_id', 'status'])
export class AttachmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  @Index()
  readonly owner_profile_id!: string;

  @Column({ type: 'varchar', length: 500 })
  readonly original_file_name!: string;

  @Column({ type: 'varchar', length: 25 })
  readonly kind!: AttachmentKind;

  @Column({ type: 'varchar', length: 100 })
  readonly declared_mime!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly detected_mime!: string | null;

  @Column({ type: 'varchar', length: 25 })
  @Index()
  readonly status!: AttachmentStatus;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly original_bucket!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly original_key!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly size_bytes!: number | null;

  @Column({ type: 'varchar', length: 128, nullable: true, default: null })
  readonly sha256!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly guardduty_status!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly verdict!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly ipfs_cid!: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true, default: null })
  readonly ipfs_url!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly error_reason!: string | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}

@Entity(DROP_ATTACHMENTS_TABLE)
@Index('idx_drop_attachments_drop_part', ['drop_id', 'drop_part_id'])
@Index('idx_drop_attachments_attachment', ['attachment_id'])
export class DropAttachmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @PrimaryColumn({ type: 'bigint' })
  readonly drop_part_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly attachment_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  @Index('idx_drop_attachments_wave_id')
  readonly wave_id!: string | null;
}
