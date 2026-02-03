import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RATINGS_TABLE } from '@/constants';

@Entity(RATINGS_TABLE)
@Index('idx_ratings_1', ['matter_target_id', 'rater_profile_id', 'rating'])
@Index('idx_ratings_2', [
  'matter',
  'matter_target_id',
  'rater_profile_id',
  'rating'
])
@Index('idx_ratings_3', [
  'matter',
  'matter_category',
  'rater_profile_id',
  'rating'
])
export class Rating {
  @PrimaryColumn({ type: 'varchar', length: 50, collation: 'utf8_bin' })
  rater_profile_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 50, collation: 'utf8_bin' })
  matter_target_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 50, collation: 'utf8_bin' })
  matter!: RateMatter;
  @PrimaryColumn({ type: 'varchar', length: 100, collation: 'utf8_bin' })
  matter_category!: string;
  @Column({ type: 'int' })
  rating!: number;
  @Column({ type: 'timestamp' })
  last_modified!: Date;
}

export enum RateMatter {
  CIC = 'CIC',
  REP = 'REP'
}

export function getMattersWhereTargetIsProfile(): RateMatter[] {
  return [RateMatter.CIC, RateMatter.REP];
}
