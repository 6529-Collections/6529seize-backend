import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { RATINGS_SNAPSHOTS_TABLE } from '@/constants';
import { RateMatter } from './IRating';

@Entity(RATINGS_SNAPSHOTS_TABLE)
export class RatingsSnapshot {
  @PrimaryGeneratedColumn('increment')
  id?: number;

  @Column({ type: 'varchar', length: 50, nullable: false })
  rating_matter!: RateMatter;

  @Column({ type: 'text', nullable: false })
  url!: string;

  @Column({ type: 'bigint', nullable: false })
  snapshot_time!: number;
}
