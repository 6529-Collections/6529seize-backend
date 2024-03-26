import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
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

@Entity(SUBSCRIPTIONS_NFTS_TABLE)
export class NFTSubscription {
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

  @Column({ type: 'boolean', default: false })
  locked?: boolean;
}
