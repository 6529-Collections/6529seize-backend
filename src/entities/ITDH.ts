import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn
} from 'typeorm';
import {
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_BLOCKS_TABLE,
  TDH_GLOBAL_HISTORY_TABLE,
  TDH_HISTORY_TABLE,
  TDH_NFT_TABLE,
  WALLETS_TDH_MEMES_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';

export class BaseTDHFields {
  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'double', nullable: false })
  tdh!: number;

  @Column({ type: 'double', nullable: false })
  boost!: number;

  @Column({ type: 'double', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'double', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;
}

export class BaseTDH extends BaseTDHFields {
  @PrimaryColumn({ type: 'int' })
  block!: number;

  @Column({ type: 'datetime' })
  date!: Date;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_gradients!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_nextgen!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: number;

  @Column({ type: 'int', nullable: false })
  nakamoto!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'double', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'double', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'json', nullable: true })
  memes!: TokenTDH[];

  @Column({ type: 'json', nullable: true })
  memes_ranks!: TokenTDHRank[];

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_gradients_tdh!: number;

  @Column({ type: 'double', nullable: false })
  gradients_tdh!: number;

  @Column({ type: 'double', nullable: false })
  gradients_tdh__raw!: number;

  @Column({ type: 'json', nullable: true })
  gradients!: TokenTDH[];

  @Column({ type: 'json', nullable: true })
  gradients_ranks!: TokenTDHRank[];

  @Column({ type: 'int', nullable: false })
  nextgen_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_nextgen_tdh!: number;

  @Column({ type: 'double', nullable: false })
  nextgen_tdh!: number;

  @Column({ type: 'double', nullable: false })
  nextgen_tdh__raw!: number;

  @Column({ type: 'json', nullable: true })
  nextgen!: TokenTDH[];

  @Column({ type: 'json', nullable: true })
  nextgen_ranks!: TokenTDHRank[];

  @Column({ type: 'json', nullable: true })
  boost_breakdown!: any;
}

@Entity(WALLETS_TDH_TABLE)
@Index('tdh_block_wallet_idx', ['block', 'wallet'], {
  where: `"wallet" = lower("wallet")`
})
export class TDH extends BaseTDH {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

export interface TDHENS extends TDH {
  ens: string;
}

@Entity(CONSOLIDATED_WALLETS_TDH_TABLE)
export class ConsolidatedTDH extends BaseTDH {
  @Column({ type: 'varchar', length: 500 })
  @Index()
  consolidation_display!: string;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;
}

@Entity(WALLETS_TDH_MEMES_TABLE)
export class TDHMemes extends BaseTDHFields {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @PrimaryColumn({ type: 'int' })
  season!: number;
}

@Entity(CONSOLIDATED_WALLETS_TDH_MEMES_TABLE)
export class ConsolidatedTDHMemes extends BaseTDHFields {
  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_key!: string;

  @PrimaryColumn({ type: 'int' })
  season!: number;
}

@Entity(TDH_NFT_TABLE)
export class NftTDH {
  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'double', nullable: false })
  tdh!: number;

  @Column({ type: 'double', nullable: false })
  boost!: number;

  @Column({ type: 'double', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'double', nullable: false })
  tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank!: number;
}

@Entity(TDH_BLOCKS_TABLE)
export class TDHBlock {
  @CreateDateColumn()
  created_at?: Date;

  @PrimaryColumn({ type: 'int' })
  block_number!: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp!: Date;
}

@Entity(TDH_GLOBAL_HISTORY_TABLE)
export class GlobalTDHHistory {
  @PrimaryColumn({ type: 'date' })
  date!: Date;

  @PrimaryColumn({ type: 'int' })
  block!: number;

  @Column({ type: 'int' })
  created_tdh!: number;

  @Column({ type: 'int' })
  destroyed_tdh!: number;

  @Column({ type: 'int' })
  net_tdh!: number;

  @Column({ type: 'int', nullable: false })
  created_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  net_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  created_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  net_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  created_balance!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_balance!: number;

  @Column({ type: 'int', nullable: false })
  net_balance!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'int', nullable: false })
  nextgen_balance!: number;

  @Column({ type: 'int', nullable: false })
  total_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  total_tdh!: number;

  @Column({ type: 'int', nullable: false })
  total_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  gradients_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  total_consolidated_wallets!: number;

  @Column({ type: 'int', nullable: false })
  total_wallets!: number;
}

@Entity(TDH_HISTORY_TABLE)
export class TDHHistory {
  @PrimaryColumn({ type: 'date' })
  date!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

  @Column({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @PrimaryColumn({ type: 'int' })
  block!: number;

  @Column({ type: 'json', nullable: false })
  wallets?: any;

  @Column({ type: 'int' })
  boosted_tdh!: number;

  @Column({ type: 'int' })
  tdh!: number;

  @Column({ type: 'int' })
  tdh__raw!: number;

  @Column({ type: 'int' })
  created_tdh!: number;

  @Column({ type: 'int' })
  destroyed_tdh!: number;

  @Column({ type: 'int' })
  net_tdh!: number;

  @Column({ type: 'int', nullable: false })
  created_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  net_boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
  created_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  net_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  created_balance!: number;

  @Column({ type: 'int', nullable: false })
  destroyed_balance!: number;

  @Column({ type: 'int', nullable: false })
  net_balance!: number;
}

export interface TokenTDH {
  id: number;
  balance: number;
  tdh: number;
  tdh__raw: number;
}

export interface TokenTDHRank {
  id: number;
  rank: number;
}

export interface BoostInfo {
  available: number;
  available_info: string[];
  acquired: number;
  acquired_info: string[];
}

export interface DefaultBoost {
  memes_card_sets: BoostInfo;
  memes_szn1: BoostInfo;
  memes_szn2: BoostInfo;
  memes_szn3: BoostInfo;
  memes_szn4: BoostInfo;
  memes_szn5: BoostInfo;
  memes_szn6: BoostInfo;
  memes_genesis: BoostInfo;
  memes_nakamoto: BoostInfo;
  gradients: BoostInfo;
}
