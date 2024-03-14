import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import {
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  NEVER_DATE,
  NFTDELEGATION_BLOCKS_TABLE
} from '../constants';
import { BlockEntity } from './IBlock';

@Entity(CONSOLIDATIONS_TABLE)
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

export interface WalletConsolidationKey {
  wallet: string;
  consolidation_key: string;
}
