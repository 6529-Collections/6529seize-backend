import { Column, Entity, PrimaryColumn } from 'typeorm';
import { CIC_RATINGS_TABLE } from '../constants';

@Entity(CIC_RATINGS_TABLE)
export class CicRating {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  target_profile_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  rater_profile_id!: string;

  @Column({ type: 'bigint', nullable: false })
  rating!: number;
}
