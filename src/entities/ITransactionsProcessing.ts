import { Entity } from 'typeorm';
import { TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE } from '../constants';
import { BlockEntity } from './IBlock';

@Entity(TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE)
export class TransactionsProcessedDistributionBlock extends BlockEntity {}
