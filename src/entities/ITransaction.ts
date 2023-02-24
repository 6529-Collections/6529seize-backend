import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

@Entity()
export class Transaction {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 100 })
  transaction!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'datetime' })
  transaction_date!: Date;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 50 })
  from_address!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 50 })
  to_address!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Index()
  @PrimaryColumn({ type: 'int' })
  token_id!: number;

  @Column({ type: 'int' })
  token_count!: number;

  @Column({ type: 'double' })
  value!: number;
}

export interface TransactionValue {
  transaction: string;
  value: number;
}
