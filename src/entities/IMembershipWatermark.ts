import { MEMBERSHIP_WATERMARKS_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-dimension freshness watermarks for materialized group membership.
 * The refresh loop records full-backfill and time-bound grant progress here.
 */
@Entity(MEMBERSHIP_WATERMARKS_TABLE)
export class MembershipWatermarkEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly dimension!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly watermark_millis!: string;

  // Optional machine-readable detail such as the eligibility spec version.
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly detail!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
