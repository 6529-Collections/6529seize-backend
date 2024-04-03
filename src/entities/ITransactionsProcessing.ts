import { Entity, Index, PrimaryColumn } from 'typeorm';
import {
  TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE,
  TRANSACTIONS_PROCESSED_DISTRIBUTION_TRANSACTIONS_TABLE
} from '../constants';
import { BlockEntity } from './IBlock';

@Entity(TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE)
export class TransactionsProcessedDistributionBlock extends BlockEntity {}

@Entity(TRANSACTIONS_PROCESSED_DISTRIBUTION_TRANSACTIONS_TABLE)
export class TransactionsProcessedDistributionTransaction {
  @Index()
  @PrimaryColumn({ type: 'varchar', length: 100 })
  transaction!: string;

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
  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;
}
