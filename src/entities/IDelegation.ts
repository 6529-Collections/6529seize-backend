import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import { CONSOLIDATIONS_TABLE, DELEGATIONS_TABLE } from '../constants';

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

  @Column({ type: 'int' })
  block!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  from_address!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  to_address!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  collection!: string;

  @PrimaryColumn({ type: 'int' })
  use_case!: number;
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

export interface ConsolidationEvent extends Event {}

export interface DelegationEvent extends ConsolidationEvent {
  collection: string;
  use_case: number;
}
