import {
  Column,
  Entity,
  PrimaryColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  WALLETS_MEMES_TDH_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';

@Entity(WALLETS_TDH_TABLE)
@Index('tdh_block_wallet_idx', ['block', 'wallet'], {
  where: `"wallet" = lower("wallet")`
})
export class TDH {
  @Column({ type: 'datetime' })
  date!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @PrimaryColumn({ type: 'int' })
  block!: number;

  @Column({ type: 'int', nullable: false })
  tdh!: number;

  @Column({ type: 'double', nullable: false })
  boost!: number;

  @Column({ type: 'int', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_gradients!: number;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: boolean;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'json', nullable: true })
  memes?: any;

  @Column({ type: 'json', nullable: true })
  memes_ranks?: any;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh__raw!: number;

  @Column({ type: 'json', nullable: true })
  gradients?: any;

  @Column({ type: 'json', nullable: true })
  gradients_ranks?: any;
}

export abstract class SeasonsTDHBase {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @PrimaryColumn({ type: 'int' })
  season!: number;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  unique!: number;

  @Column({ type: 'double', nullable: false })
  boost!: number;

  @Column({ type: 'double', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  tdh!: number;

  @Column({ type: 'int', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;
}

@Entity(WALLETS_MEMES_TDH_TABLE)
export class SeasonsTDH extends SeasonsTDHBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}
export interface TDHENS extends TDH {
  ens: string;
}

@Entity(CONSOLIDATED_WALLETS_TDH_TABLE)
export class ConsolidatedTDH {
  @Column({ type: 'datetime' })
  date!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;

  @Column({ type: 'int' })
  block!: number;

  @Column({ type: 'int', nullable: false })
  tdh!: number;

  @Column({ type: 'double', nullable: false })
  boost!: number;

  @Column({ type: 'int', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_gradients!: number;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: boolean;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'json', nullable: true })
  memes?: any;

  @Column({ type: 'json', nullable: true })
  memes_ranks?: any;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh__raw!: number;

  @Column({ type: 'json', nullable: true })
  gradients?: any;

  @Column({ type: 'json', nullable: true })
  gradients_ranks?: any;
}

export interface TokenTDH {
  id: string;
  balance: number;
  tdh: number;
  tdh__raw: number;
}
