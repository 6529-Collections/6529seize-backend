import { SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE)
@Index('idx_sc_refresh_dirty_key', ['dirty_at', 'consolidation_key'])
export class SubscriptionCoverageRefreshRequestEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly consolidation_key!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly reason!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly dirty_at!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
