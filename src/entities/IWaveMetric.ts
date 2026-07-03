import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_METRICS_TABLE } from '@/constants';

@Entity(WAVE_METRICS_TABLE)
@Index('idx_wmet_dc_wi', ['drops_count', 'wave_id'])
@Index('idx_wmet_ldt_wi', ['latest_drop_timestamp', 'wave_id'])
@Index('idx_wmet_sc_wi', ['subscribers_count', 'wave_id'])
@Index('idx_wmet_vis_score', [
  'wave_visibility_rank',
  'wave_visibility_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_hot_score', [
  'wave_hotness_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_quality_score', [
  'wave_quality_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_rank_quality_score', [
  'wave_visibility_rank',
  'wave_quality_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_rep_score', [
  'wave_rep_sort_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_rank_hot_score', [
  'wave_visibility_rank',
  'wave_hotness_score',
  'latest_drop_timestamp',
  'wave_id'
])
@Index('idx_wmet_rank_rep_score', [
  'wave_visibility_rank',
  'wave_rep_sort_score',
  'latest_drop_timestamp',
  'wave_id'
])
export class WaveMetricEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly participatory_drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly subscribers_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly latest_drop_timestamp!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_total!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_positive!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_negative!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_contributor_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_positive_contributor_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_rep_negative_contributor_count!: number;
  @Column({
    type: 'varchar',
    length: 50,
    nullable: false,
    default: 'wave-score-v1'
  })
  readonly wave_score_version!: string;
  @Column({
    type: 'varchar',
    length: 50,
    nullable: false,
    default: 'EXPLORATION_NEUTRAL'
  })
  readonly wave_visibility_tier!: string;
  @Column({ type: 'int', nullable: false, default: 2 })
  readonly wave_visibility_rank!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_quality_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_hotness_score!: number;
  @Column({ type: 'double', nullable: false, default: 50 })
  readonly wave_rep_sort_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_visibility_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_creator_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_level_weighted_participation_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_trusted_diversity_score!: number;
  @Column({ type: 'double', nullable: false, default: 50 })
  readonly wave_rep_component_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_trusted_subscription_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_recent_trusted_activity_score!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_single_actor_penalty!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_low_trust_flood_penalty!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_cross_post_pressure!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_cross_post_penalty!: number;
  @Column({ type: 'double', nullable: false, default: 0 })
  readonly wave_negative_rep_penalty!: number;
  @Column({ type: 'double', nullable: false, default: 1 })
  readonly wave_safety_multiplier!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly wave_score_calculated_at!: number;
}
