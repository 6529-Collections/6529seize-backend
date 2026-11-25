import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn
} from 'typeorm';
import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NEVER_DATE,
  NFTDELEGATION_BLOCKS_TABLE,
  NFTDELEGATION_LOGS_AFTER_FREEZE_TABLE
} from '@/constants';
import { BlockEntity } from './IBlock';

@Entity(CONSOLIDATIONS_TABLE)
@Index('idx_conf_wallet1', ['confirmed', 'wallet1'])
@Index('idx_conf_wallet2', ['confirmed', 'wallet2'])
export class Consolidation {
  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'int' })
  block!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet1!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet2!: string;

  @Column({ type: 'boolean', default: false })
  confirmed!: boolean;

  // Unix seconds of the block in which wallet1 last registered its link to
  // wallet2 (and wallet2 to wallet1). NULL for links indexed before these
  // columns existed, which the fourth-wallet gate treats as pre-activation.
  // Raw SQL reads may return these bigints as strings; compare via Number().
  @Column({ type: 'bigint', nullable: true, default: null })
  wallet1_registered_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  wallet2_registered_at!: number | null;
}

@Entity(DELEGATIONS_TABLE)
export class Delegation {
  @CreateDateColumn()
  created_at!: Date;

  @PrimaryColumn({ type: 'int' })
  block!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  from_address!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  to_address!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  collection!: string;

  @PrimaryColumn({ type: 'int' })
  use_case!: number;

  @Column({ type: 'bigint', default: NEVER_DATE })
  expiry!: number;

  @Column({ type: 'boolean', default: true })
  all_tokens!: boolean;

  @Column({ type: 'int', default: 0 })
  token_id!: number;
}

export enum EventType {
  REGISTER,
  REVOKE
}

export interface Event {
  block: number;
  type: EventType;
  wallet1: string;
  wallet2: string;
  // Block timestamp in Unix seconds. Populated for consolidation events.
  timestamp?: number;
}

export type ConsolidationEvent = Event;

export interface DelegationEvent extends ConsolidationEvent {
  collection: string;
  use_case: number;
  expiry?: number;
  all_tokens?: boolean;
  token_id?: number;
}

@Entity(NFTDELEGATION_BLOCKS_TABLE)
export class NFTDelegationBlock extends BlockEntity {}

/**
 * An NFTDelegation log after the identity freeze block (B_T). From the
 * freeze, consolidations and delegations live on the 6529 chain: these are
 * kept for the record (and so the site can tell people which of their
 * NFTDelegation changes did not count), never applied.
 */
@Entity(NFTDELEGATION_LOGS_AFTER_FREEZE_TABLE)
@Index('idx_nftdelegation_logs_after_freeze_delegator', ['delegator'])
@Index('idx_nftdelegation_logs_after_freeze_delegate', ['delegate'])
export class NFTDelegationLogAfterFreeze {
  @PrimaryColumn({ type: 'int' })
  block!: number;

  @PrimaryColumn({ type: 'int' })
  log_index!: number;

  @Column({ type: 'varchar', length: 100 })
  transaction_hash!: string;

  @Column({ type: 'varchar', length: 100 })
  event_name!: string;

  /** The wallet whose delegation it is (the delegator of a sub-delegated call). */
  @Column({ type: 'varchar', length: 50 })
  delegator!: string;

  /** The wallet that sent it, when not the delegator (sub-delegation). */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  actor!: string | null;

  /** The delegate (the new one, for UpdateDelegation). */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  delegate!: string | null;

  @Column({ type: 'varchar', length: 50 })
  collection!: string;

  @Column({ type: 'int' })
  use_case!: number;

  @Column({ type: 'boolean', nullable: true, default: null })
  all_tokens!: boolean | null;

  /** uint256 as a decimal string. */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  token_id!: string | null;

  /** B_T in force when the log was recorded. */
  @Column({ type: 'int' })
  freeze_block!: number;

  @CreateDateColumn()
  created_at!: Date;
}

export interface WalletConsolidationKey {
  // matches the address_consolidation_keys view columns
  address: string;
  consolidation_key: string;
}

/** An NFTDelegation log after the freeze block, as the scan decodes it. */
export type NftDelegationLogRecord = Omit<
  NFTDelegationLogAfterFreeze,
  'freeze_block' | 'created_at'
>;
