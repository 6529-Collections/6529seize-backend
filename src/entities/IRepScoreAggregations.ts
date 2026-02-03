import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE } from '@/constants';

@Entity(PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE)
@Index('pr_tot_rep_score_aggregation_score_idx', ['score'])
export class ProfileTotalRepScoreAggregation {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;
  @Column({ type: 'bigint' })
  score!: number;
  @Column({ type: 'int' })
  rater_count!: number;
}
