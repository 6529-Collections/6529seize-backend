import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DROPS_VOTES_CREDIT_SPENDINGS_TABLE } from '../constants';

@Entity(DROPS_VOTES_CREDIT_SPENDINGS_TABLE)
export class DropVoteCreditSpending {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly rater_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly credit_spent!: number;
  @Column({ type: 'datetime' })
  readonly timestamp!: Date;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
}
