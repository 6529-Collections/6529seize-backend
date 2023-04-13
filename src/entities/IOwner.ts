import { Entity, Column, PrimaryGeneratedColumn, PrimaryColumn } from 'typeorm';

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

@Entity({ name: 'owners_tags' })
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
}

@Entity({ name: 'owners_metrics' })
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
  transfers_in_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_gradients!: number;

  @Column({ type: 'datetime', nullable: true })
  transaction_reference!: Date;
}

@Entity({ name: 'owners_metrics_consolidation' })
export class ConsolidatedOwnerMetric {
  @Column({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

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
  transfers_in_gradients!: number;

  @Column({ type: 'int', nullable: false })
  transfers_out_gradients!: number;

  @Column({ type: 'datetime', nullable: true })
  transaction_reference!: Date;
}
