import {
  CreateDateColumn,
  UpdateDateColumn,
  PrimaryColumn,
  Column,
  Entity
} from 'typeorm';
import {
  AGGREGATED_ACTIVITY_MEMES_TABLE,
  AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE
} from '@/constants';

export abstract class AggregatedActivityBase {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @Column({ type: 'double', nullable: false })
  primary_purchases_value!: number;

  @Column({ type: 'int', nullable: false })
  primary_purchases_count!: number;

  @Column({ type: 'double', nullable: false })
  secondary_purchases_value!: number;

  @Column({ type: 'int', nullable: false })
  secondary_purchases_count!: number;

  @Column({ type: 'int', nullable: false })
  burns!: number;

  @Column({ type: 'double', nullable: false })
  sales_value!: number;

  @Column({ type: 'int', nullable: false })
  sales_count!: number;

  @Column({ type: 'int', nullable: false })
  airdrops!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out!: number;
}

export abstract class AggregatedActivityBreakdown extends AggregatedActivityBase {
  // MEMES
  @Column({ type: 'double', nullable: false })
  primary_purchases_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  primary_purchases_count_memes!: number;

  @Column({ type: 'double', nullable: false })
  secondary_purchases_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  secondary_purchases_count_memes!: number;

  @Column({ type: 'int', nullable: false })
  burns_memes!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes!: number;

  @Column({ type: 'int', nullable: false })
  airdrops_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes!: number;

  // MEMELAB
  @Column({ type: 'double', nullable: false })
  primary_purchases_value_memelab!: number;

  @Column({ type: 'int', nullable: false })
  primary_purchases_count_memelab!: number;

  @Column({ type: 'double', nullable: false })
  secondary_purchases_value_memelab!: number;

  @Column({ type: 'int', nullable: false })
  secondary_purchases_count_memelab!: number;

  @Column({ type: 'int', nullable: false })
  burns_memelab!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memelab!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memelab!: number;

  @Column({ type: 'int', nullable: false })
  airdrops_memelab!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memelab!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memelab!: number;

  // GRADIENTS
  @Column({ type: 'double', nullable: false })
  primary_purchases_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  primary_purchases_count_gradients!: number;

  @Column({ type: 'double', nullable: false })
  secondary_purchases_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  secondary_purchases_count_gradients!: number;

  @Column({ type: 'int', nullable: false })
  burns_gradients!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_gradients!: number;

  @Column({ type: 'int', nullable: false })
  airdrops_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_gradients!: number;

  // NEXTGEN
  @Column({ type: 'double', nullable: false })
  primary_purchases_value_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  primary_purchases_count_nextgen!: number;

  @Column({ type: 'double', nullable: false })
  secondary_purchases_value_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  secondary_purchases_count_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  burns_nextgen!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  airdrops_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_nextgen!: number;
}

@Entity(AGGREGATED_ACTIVITY_TABLE)
export class AggregatedActivity extends AggregatedActivityBreakdown {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int' })
  block_reference!: number;
}

@Entity(CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE)
export class ConsolidatedAggregatedActivity extends AggregatedActivityBreakdown {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}

@Entity(AGGREGATED_ACTIVITY_MEMES_TABLE)
export class AggregatedActivityMemes extends AggregatedActivityBase {
  @PrimaryColumn({ type: 'int' })
  season!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

@Entity(CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE)
export class ConsolidatedAggregatedActivityMemes extends AggregatedActivityBase {
  @PrimaryColumn({ type: 'int' })
  season!: number;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}
