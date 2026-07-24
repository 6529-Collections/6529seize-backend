import { MEMBERSHIP_WATERMARKS_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-dimension freshness watermarks for materialized group membership
 * (e.g. RATINGS, TDH, NFT_OWNERSHIP, CONSOLIDATION, GRANTS, GROUP_DEF).
 * Dark for now: nothing reads or writes this table yet.
 */
@Entity(MEMBERSHIP_WATERMARKS_TABLE)
export class MembershipWatermarkEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly dimension!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly watermark_millis!: string;

  // Future chain-height/block mapping for the watermark.
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly detail!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
