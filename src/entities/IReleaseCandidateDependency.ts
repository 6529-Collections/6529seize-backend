import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_CANDIDATE_DEPENDENCIES_TABLE } from '@/constants';
import type { ReleaseDependencyRequiredState } from '@/releaseBus/release-bus.types';

@Entity(RELEASE_CANDIDATE_DEPENDENCIES_TABLE)
@Index(
  'uq_release_candidate_dependency',
  ['candidate_id', 'depends_on_candidate_id', 'required_state'],
  { unique: true }
)
@Index('idx_release_dependency_target', ['depends_on_candidate_id'])
export class ReleaseCandidateDependencyEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly candidate_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly depends_on_candidate_id!: string;
  @Column({ type: 'varchar', length: 32 })
  readonly required_state!: ReleaseDependencyRequiredState;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
}
