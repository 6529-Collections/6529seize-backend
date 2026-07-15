import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_TRAIN_OPERATIONS_TABLE } from '@/constants';
import type { ReleaseOperationStatus } from '@/releaseBus/release-bus.types';

@Entity(RELEASE_TRAIN_OPERATIONS_TABLE)
@Index('uq_release_train_operation_key', ['operation_key'], { unique: true })
@Index('idx_release_operation_train_status', ['train_id', 'status'])
export class ReleaseTrainOperationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 500 }) readonly operation_key!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'int' }) readonly revision!: number;
  @Column({ type: 'varchar', length: 64 }) readonly operation_type!: string;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly repository!: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly environment!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly service!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly expected_sha!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly artifact_digest!: string | null;
  @Column({ type: 'int', default: 1 }) readonly attempt!: number;
  @Column({ type: 'varchar', length: 24 })
  readonly status!: ReleaseOperationStatus;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly external_id!: string | null;
  @Column({ type: 'json', nullable: true })
  readonly request_metadata_json!: unknown;
  @Column({ type: 'json', nullable: true })
  readonly result_metadata_json!: unknown;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly started_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}
