import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TDH_SPENT_ON_DROP_REPS_TABLE } from '../constants';

@Entity(TDH_SPENT_ON_DROP_REPS_TABLE)
export class TdhSpentOnDropRep {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly rater_id!: string;
  @Column({ type: 'bigint' })
  readonly drop_id!: number;
  @Column({ type: 'bigint' })
  readonly tdh_spent!: number;
  @Column({ type: 'datetime' })
  readonly timestamp!: Date;
}
