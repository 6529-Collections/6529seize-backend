import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity('consolidations')
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

export enum ConsolidationType {
  REGISTER,
  REVOKE
}

export interface ConsolidationEvent {
  block: number;
  type: ConsolidationType;
  wallet1: string;
  wallet2: string;
}
