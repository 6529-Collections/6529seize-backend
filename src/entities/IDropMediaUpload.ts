import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_MEDIA_UPLOADS_TABLE } from '@/constants';

export enum DropMediaUploadSource {
  DROP = 'drop',
  WAVE = 'wave'
}

export enum DropMediaUploadStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed'
}

@Entity(DROP_MEDIA_UPLOADS_TABLE)
@Index('idx_drop_media_upload_s3_upload', ['s3_upload_id'])
export class DropMediaUploadEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 20 })
  readonly source!: DropMediaUploadSource;

  @Column({ type: 'varchar', length: 2000 })
  readonly public_key!: string;

  @Column({ type: 'varchar', length: 2000 })
  readonly public_url!: string;

  @Column({ type: 'varchar', length: 255 })
  readonly ingest_bucket!: string;

  @Column({ type: 'varchar', length: 2000 })
  readonly ingest_key!: string;

  @Column({ type: 'varchar', length: 500 })
  readonly s3_upload_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly declared_mime_type!: string;

  @Index()
  @Column({ type: 'varchar', length: 20 })
  readonly status!: DropMediaUploadStatus;

  @Column({ type: 'text', nullable: true, default: null })
  readonly error_reason!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly drop_id!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
}
