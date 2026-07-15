import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_DEPLOYMENT_LANES_TABLE } from '@/constants';

@Entity(RELEASE_DEPLOYMENT_LANES_TABLE)
@Index('idx_release_lane_train', ['train_id'])
export class ReleaseDeploymentLaneEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 }) readonly name!: string;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly train_id!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly lease_owner!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly lease_token!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly heartbeat_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly expires_at!: number | null;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}
