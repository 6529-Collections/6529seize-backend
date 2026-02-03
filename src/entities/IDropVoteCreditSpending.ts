import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROPS_VOTES_CREDIT_SPENDINGS_TABLE } from '@/constants';

@Entity(DROPS_VOTES_CREDIT_SPENDINGS_TABLE)
export class DropVoteCreditSpending {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly voter_id!: string;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly credit_spent!: number;
  @Index()
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
}
