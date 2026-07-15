import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_TRAIN_EVENTS_TABLE } from '@/constants';

@Entity(RELEASE_TRAIN_EVENTS_TABLE)
@Index('idx_release_train_event_train_created', ['train_id', 'created_at'])
@Index('idx_release_train_event_candidate_created', [
  'candidate_id',
  'created_at'
])
export class ReleaseTrainEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly train_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly candidate_id!: string | null;
  @Column({ type: 'varchar', length: 64 }) readonly event_type!: string;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly github_actor!: string | null;
  @Column({ type: 'json', nullable: true }) readonly payload_json!: unknown;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}
