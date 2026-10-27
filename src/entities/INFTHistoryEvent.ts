import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn
} from 'typeorm';
import { NFTS_HISTORY_EVENTS_TABLE } from '@/constants';

// Additive storage: never change or rebuild the legacy URI-keyed primary key.
@Entity(NFTS_HISTORY_EVENTS_TABLE)
@Index(['contract', 'nft_id', 'block'])
export class NFTHistoryEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  event_id!: string;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  nft_id!: number;

  @Column({ type: 'text', collation: 'utf8mb4_bin' })
  uri!: string;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamp' })
  transaction_date!: Date;

  @Column({ type: 'varchar', length: 66 })
  transaction_hash!: string;

  @Column({ type: 'varchar', length: 66 })
  block_hash!: string;

  @Column({ type: 'varchar', length: 42 })
  extension!: string;

  @Column({ type: 'varchar', length: 78 })
  claim_id!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'int' })
  transaction_index!: number;

  @Column({ type: 'int' })
  log_index!: number;

  // A claim settings update with the same URI is audited but not a Timeline edit.
  @Column({ type: 'json', nullable: true })
  description!: HistoryEdit | null;
}

export interface HistoryChange {
  key: string;
  from: unknown;
  to: unknown;
}

export interface HistoryEdit {
  event: 'Edit';
  changes: HistoryChange[];
}
