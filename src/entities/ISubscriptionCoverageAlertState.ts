import { SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE)
@Index('idx_sc_alert_status_updated', ['current_status', 'updated_at'])
export class SubscriptionCoverageAlertStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly consolidation_key!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly current_status!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly current_fingerprint!: string;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly current_at_risk_token_id!: number | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly current_fully_funded_drops!: number;

  @Column({ type: 'int', nullable: true, default: null })
  readonly current_requested_mints!: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  readonly current_missing_mints!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly recipient_profile_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  readonly last_notified_status!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  readonly last_notified_fingerprint!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_notified_at!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
