import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CLAP_CREDIT_SPENDINGS_TABLE } from '../constants';

@Entity(CLAP_CREDIT_SPENDINGS_TABLE)
export class ClapCreditSpendingEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly clapper_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly credit_spent!: number;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
}
