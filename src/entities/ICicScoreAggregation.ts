import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { CIC_SCORE_AGGREGATIONS_TABLE } from '@/constants';

@Entity(CIC_SCORE_AGGREGATIONS_TABLE)
@Index('cic_score_aggregation_score_idx', ['score'])
export class CicScoreAggregation {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;
  @Column({ type: 'bigint' })
  score!: number;
  @Column({ type: 'int' })
  rater_count!: number;
}
