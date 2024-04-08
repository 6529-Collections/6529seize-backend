import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '../constants';

@Entity(SUBSCRIPTIONS_TOP_UP_TABLE)
export class SubscriptionTopUp {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  hash!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'datetime' })
  transaction_date!: Date;

  @Column({ type: 'varchar', length: 50 })
  from_wallet!: string;

  @Column({ type: 'double' })
  amount!: number;
}

@Entity(SUBSCRIPTIONS_BALANCES_TABLE)
export class SubscriptionBalance {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'double' })
  balance!: number;
}

@Entity(SUBSCRIPTIONS_MODE_TABLE)
export class SubscriptionMode {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'boolean' })
  automatic!: boolean;
}

class NFTSubscriptionFields {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  contract!: string;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;
}

@Entity(SUBSCRIPTIONS_NFTS_TABLE)
export class NFTSubscription extends NFTSubscriptionFields {}

@Entity(SUBSCRIPTIONS_NFTS_FINAL_TABLE)
export class NFTFinalSubscription extends NFTSubscriptionFields {
  @Column({ type: 'text' })
  airdrop_address!: string;

  @Column({ type: 'double' })
  balance!: number;

  @Column({ type: 'text', default: null })
  subscribed_at!: string;

  @Column({ type: 'boolean', default: false })
  redeemed!: boolean;
}

@Entity(SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE)
export class NFTFinalSubscriptionUpload {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  contract!: string;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'varchar', length: 10 })
  date?: string;

  @Column({ type: 'varchar', length: 100 })
  upload_url!: string;
}
export class NFTFinalSubscriptionWithDateAndProfile extends NFTFinalSubscription {
  date!: string;
  profile!: string;
}

@Entity(SUBSCRIPTIONS_LOGS_TABLE)
export class SubscriptionLog {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'text' })
  log!: string;
}

@Entity(SUBSCRIPTIONS_REDEEMED_TABLE)
export class RedeemedSubscription {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'int' })
  token_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  address!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  transaction!: string;

  @Column({ type: 'datetime', nullable: true, default: null })
  transaction_date!: Date;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'double' })
  value!: number;

  @Column({ type: 'double' })
  balance_after!: number;
}
