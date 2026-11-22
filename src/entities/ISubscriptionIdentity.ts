import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn
} from 'typeorm';
import {
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_KEY_MAP_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE
} from '@/constants';

/*
 * The identity-keyed subscription tables. Each mirrors a legacy
 * subscriptions_* table column for column, with `identity_key` in place of
 * the consolidation key: a 6529 chain principal id (0x and 64 hex) for a
 * bound wallet, else the wallet. They are filled from the opening file
 * (src/subscriptions-identity/opening) and are the truth only after the
 * identity switch (identity-switch.ts). History rows also keep the
 * consolidation key they were written under.
 */

/** A principal id is 66 characters; a wallet is 42. */
const IDENTITY_KEY_LENGTH = 66;

@Entity(SUBSCRIPTIONS_ID_TOP_UP_TABLE)
export class SubscriptionIdTopUpEntity {
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

  /** The identity the top-up is attributed to (the sender's). */
  @Index('idx_subscriptions_id_top_up_identity')
  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;
}

@Entity(SUBSCRIPTIONS_ID_BALANCES_TABLE)
export class SubscriptionIdBalanceEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  @Column({ type: 'double' })
  balance!: number;
}

@Entity(SUBSCRIPTIONS_ID_MODE_TABLE)
export class SubscriptionIdModeEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  @Column({ type: 'boolean', default: false })
  automatic!: boolean;

  @Column({ type: 'boolean', default: false })
  subscribe_all_editions!: boolean;
}

/** A choice for an upcoming card (legacy subscriptions_nfts). */
@Entity(SUBSCRIPTIONS_ID_NFTS_TABLE)
@Unique('uq_subscriptions_id_nfts', ['identity_key', 'contract', 'token_id'])
export class SubscriptionIdChoiceEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  @Column({ type: 'varchar', length: 100 })
  contract!: string;

  @Column({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'int', default: 1 })
  subscribed_count!: number;

  @Column({ type: 'boolean', default: true })
  subscribed!: boolean;

  @Column({ type: 'boolean', default: false })
  automatic_subscription!: boolean;
}

/**
 * A card's final-list row. Past lists can hold two rows that now belong to
 * one identity (people who consolidated later), so (identity, card) is not
 * unique here; the row keeps the key it was listed under. Rows from the
 * opening file keep their legacy id: the mint log records phase changes by
 * final row id.
 */
@Entity(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE)
@Index('idx_subscriptions_id_final_card', ['contract', 'token_id'])
@Index('idx_subscriptions_id_final_identity', [
  'identity_key',
  'contract',
  'token_id'
])
export class SubscriptionIdFinalEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at?: Date;

  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  /** The consolidation key the row was listed under. */
  @Column({ type: 'text' })
  consolidation_key!: string;

  @Column({ type: 'varchar', length: 100 })
  contract!: string;

  @Column({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'int', default: 1 })
  subscribed_count!: number;

  @Column({ type: 'text' })
  airdrop_address!: string;

  @Column({ type: 'double' })
  balance!: number;

  @Column({ type: 'text', default: null })
  subscribed_at!: string | null;

  @Column({ type: 'text', default: null })
  phase!: string | null;

  @Column({ type: 'int', default: -1 })
  phase_subscriptions!: number;

  @Column({ type: 'int', default: -1 })
  phase_position!: number;

  @Column({ type: 'int', default: 0 })
  redeemed_count!: number;
}

@Entity(SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE)
export class SubscriptionIdFinalUploadEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  contract!: string;

  @PrimaryColumn({ type: 'bigint' })
  token_id!: number;

  @Column({ type: 'varchar', length: 10 })
  date!: string;

  @Column({ type: 'varchar', length: 100 })
  upload_url!: string;
}

/**
 * A subscription log line. A legacy line whose key now spans several
 * identities is copied to each of them; `legacy_id` is the legacy row's id.
 */
@Entity(SUBSCRIPTIONS_ID_LOGS_TABLE)
@Index('idx_subscriptions_id_logs_identity', ['identity_key', 'id'])
export class SubscriptionIdLogEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  id?: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  legacy_id!: number | null;

  /** For a line that waited in the key-width guard's queue: its sequence. */
  @Column({ type: 'bigint', nullable: true, default: null })
  queue_sequence!: number | null;

  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  /** The consolidation key the line was written under. */
  @Column({ type: 'text' })
  consolidation_key!: string;

  @Column({ type: 'text' })
  log!: string;

  @Column({ type: 'text', nullable: true })
  additional_info!: string | null;
}

@Entity(SUBSCRIPTIONS_ID_REDEEMED_TABLE)
@Index('idx_subscriptions_id_redeemed_identity', ['identity_key'])
@Index('idx_subscriptions_id_redeemed_card', ['contract', 'token_id'])
export class SubscriptionIdRedeemedEntity {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  id?: number;

  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  /** The consolidation key the redemption was charged to. */
  @Column({ type: 'text' })
  consolidation_key!: string;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  token_id!: number;

  @Column({ type: 'varchar', length: 50 })
  address!: string;

  @Column({ type: 'varchar', length: 100 })
  transaction!: string;

  @Column({ type: 'datetime', nullable: true, default: null })
  transaction_date!: Date | null;

  @Column({ type: 'double' })
  value!: number;

  @Column({ type: 'double' })
  balance_after!: number;

  @Column({ type: 'int', default: 1 })
  count!: number;
}

/** Every consolidation key in the opening file and where it went. */
@Entity(SUBSCRIPTIONS_ID_KEY_MAP_TABLE)
export class SubscriptionIdKeyMapEntity {
  @PrimaryColumn({ type: 'varchar', length: 700 })
  consolidation_key!: string;

  /** The identity its current state (balance, mode, choices) went to. */
  @Column({ type: 'varchar', length: IDENTITY_KEY_LENGTH })
  identity_key!: string;

  /** Every identity the key's wallets belong to, sorted. */
  @Column({ type: 'json' })
  identities!: string[];
}

/**
 * One row, id 'opening': the opening file loaded into the identity tables.
 * The identity tables are the truth only while `verified_at` is set and
 * `suspended_at` is not (see identity-switch.ts).
 */
@Entity(SUBSCRIPTIONS_ID_STATE_TABLE)
export class SubscriptionIdStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  opening_sha256!: string;

  @Column({ type: 'varchar', length: 64 })
  history_sha256!: string;

  @Column({ type: 'bigint' })
  cut_at!: number;

  @Column({ type: 'bigint' })
  loaded_at!: number;

  /** The load was compared with the legacy tables and matched. */
  @Column({ type: 'bigint', nullable: true, default: null })
  verified_at!: number | null;

  /** Rollback: set, and every reader is back on the legacy tables in 60 s. */
  @Column({ type: 'bigint', nullable: true, default: null })
  suspended_at!: number | null;
}
