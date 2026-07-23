import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_TRAIN_EVIDENCE_TABLE } from '@/constants';

@Entity(RELEASE_TRAIN_EVIDENCE_TABLE)
@Index('idx_release_evidence_train_kind', [
  'train_id',
  'revision',
  'evidence_type'
])
@Index('uq_release_evidence_key', ['evidence_key'], { unique: true })
@Index('idx_release_evidence_candidate', ['candidate_id'])
@Index('idx_release_evidence_source', ['evidence_type', 'source_sha'])
export class ReleaseTrainEvidenceEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 500 })
  readonly evidence_key!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'int' }) readonly revision!: number;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly candidate_id!: string | null;
  @Column({ type: 'varchar', length: 64 }) readonly evidence_type!: string;
  @Column({ type: 'varchar', length: 24 }) readonly status!: string;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly source_sha!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly artifact_digest!: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly evidence_uri!: string | null;
  @Column({ type: 'json', nullable: true }) readonly metadata_json!: unknown;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}
