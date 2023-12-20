import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  CONSOLIDATED_OWNERS_METRICS_TABLE,
  CONSOLIDATED_OWNERS_TAGS_TABLE,
  OWNERS_METRICS_TABLE,
  OWNERS_TAGS_TABLE,
  OWNERS_TRANSACTIONS_TABLE,
  OWNERS_BALANCES_TABLE,
  OWNERS_MEMES_BALANCES_TABLE,
  CONSOLIDATED_OWNERS_TRANSACTIONS_TABLE
} from '../constants';

@Entity()
export class Owner {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @PrimaryColumn({ type: 'int' })
  token_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  balance!: number;
}

@Entity({ name: OWNERS_TAGS_TABLE })
export class OwnerTags {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn1!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn2!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn3!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn4!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn5!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: number;

  @Column({ type: 'int', nullable: false })
  nakamoto!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus1!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus2!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn1!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn2!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn3!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn4!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn5!: number;
}

@Entity({ name: CONSOLIDATED_OWNERS_TAGS_TABLE })
export class ConsolidatedOwnerTags {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn1!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn2!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn3!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn4!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes_szn5!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: number;

  @Column({ type: 'int', nullable: false })
  nakamoto!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus1!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus2!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn1!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn2!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn3!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn4!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_szn5!: number;
}

@Entity({ name: OWNERS_METRICS_TABLE })
export class OwnerMetric {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season5!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary!: number;

  @Column({ type: 'double', nullable: false })
  sales_value!: number;

  @Column({ type: 'int', nullable: false })
  sales_count!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_gradients!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_gradients!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_gradients!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_gradients!: number;

  @Column({ type: 'datetime', nullable: true })
  transaction_reference!: Date;
}

@Entity({ name: CONSOLIDATED_OWNERS_METRICS_TABLE })
export class ConsolidatedOwnerMetric {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season5!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary!: number;

  @Column({ type: 'double', nullable: false })
  sales_value!: number;

  @Column({ type: 'int', nullable: false })
  sales_count!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_gradients!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_primary_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_primary_gradients!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  purchases_value_secondary_gradients!: number;

  @Column({ type: 'int', nullable: false })
  purchases_count_secondary_gradients!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season1!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season2!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season3!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season4!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_memes_season5!: number;

  @Column({ type: 'double', nullable: false })
  sales_value_gradients!: number;

  @Column({ type: 'int', nullable: false })
  sales_count_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season1!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season2!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season3!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_memes_season5!: number;

  @Column({ type: 'int', nullable: false })
  transfers_in_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_gradients!: number;

  @Column({ type: 'datetime', nullable: true })
  transaction_reference!: Date;
}

@Entity({ name: OWNERS_MEMES_BALANCES_TABLE })
export class OwnerMemesBalances {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @PrimaryColumn({ type: 'int' })
  season!: number;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  unique!: number;
}

@Entity({ name: OWNERS_BALANCES_TABLE })
export class OwnerBalances {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int', nullable: false })
  total!: number;

  @Column({ type: 'int', nullable: false })
  unique!: number;

  @Column({ type: 'int', nullable: false })
  memes!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  gradients!: number;
}

export abstract class OwnerTransactionsBase {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'int' })
  season!: number;

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

@Entity({ name: OWNERS_TRANSACTIONS_TABLE })
export class OwnerTransactions extends OwnerTransactionsBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

@Entity({ name: CONSOLIDATED_OWNERS_TRANSACTIONS_TABLE })
export class ConsolidatedOwnerTransactions extends OwnerTransactionsBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}
