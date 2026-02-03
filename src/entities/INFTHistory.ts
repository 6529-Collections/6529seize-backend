import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import {
  NFTS_HISTORY_BLOCKS_TABLE,
  NFTS_HISTORY_CLAIMS_TABLE,
  NFTS_HISTORY_TABLE
} from '@/constants';

@Entity(NFTS_HISTORY_BLOCKS_TABLE)
export class NFTHistoryBlock {
  @PrimaryColumn({ type: 'int' })
  block!: number;

  @CreateDateColumn()
  created_at!: Date;
}

@Entity(NFTS_HISTORY_CLAIMS_TABLE)
export class NFTHistoryClaim {
  @PrimaryColumn({ type: 'bigint' })
  claimIndex!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  location!: string;

  @CreateDateColumn()
  created_at?: Date;

  @Column({ type: 'int', default: -1 })
  nft_id?: number;
}

@Entity(NFTS_HISTORY_TABLE)
export class NFTHistory {
  @PrimaryColumn({ type: 'int' })
  nft_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  uri?: string;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamp' })
  transaction_date!: Date;

  @Column({ type: 'text' })
  transaction_hash!: string;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'json' })
  description!: any;
}
