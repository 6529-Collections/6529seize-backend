import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { S3_UPLOADER_OUTBOX_TABLE } from '@/constants';
import { S3UploaderJob } from '@/s3Uploader/s3-uploader.jobs';

@Entity(S3_UPLOADER_OUTBOX_TABLE)
@Index(`${S3_UPLOADER_OUTBOX_TABLE}_status_id_idx`, ['status', 'id'])
export class S3UploaderOutboxEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Column({ type: 'json', nullable: false })
  readonly job!: S3UploaderJob;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: S3UploaderOutboxStatus;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly published_at!: number | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;
}

export enum S3UploaderOutboxStatus {
  PENDING = 'pending',
  PUBLISHED = 'published'
}
