import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_TRAINS_TABLE } from '@/constants';
import type {
  ReleaseLane,
  ReleaseTrainStatus
} from '@/releaseBus/release-bus.types';

@Entity(RELEASE_TRAINS_TABLE)
@Index('idx_release_train_lane_status', ['target_lane', 'status', 'created_at'])
export class ReleaseTrainEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'int', default: 1 }) readonly revision!: number;
  @Column({ type: 'varchar', length: 16 }) readonly target_lane!: ReleaseLane;
  @Column({ type: 'varchar', length: 32 }) readonly status!: ReleaseTrainStatus;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly cutoff_at!: number | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly frontend_base_sha!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly backend_base_sha!: string | null;
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly frontend_release_branch!: string | null;
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly backend_release_branch!: string | null;
  @Column({ type: 'int', nullable: true, default: null })
  readonly frontend_pr_number!: number | null;
  @Column({ type: 'int', nullable: true, default: null })
  readonly backend_pr_number!: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly state_machine_execution_arn!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly worker_version!: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly failure_reason!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly started_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}
