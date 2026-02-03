import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn
} from 'typeorm';
import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_BLOCKS_TABLE,
  TDH_EDITIONS_TABLE,
  TDH_NFT_TABLE,
  WALLETS_TDH_MEMES_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';

export class BaseTDHFields {
  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

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

  @Column({ type: 'int', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'json', nullable: true })
  memes!: TokenTDH[];

  @Column({ type: 'json', nullable: true })
  memes_ranks!: TokenTDHRank[];

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'int', nullable: false })
  boosted_gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh!: number;

  @Column({ type: 'int', nullable: false })
  gradients_tdh__raw!: number;

  @Column({ type: 'json', nullable: true })
  gradients!: TokenTDH[];

  @Column({ type: 'json', nullable: true })
  gradients_ranks!: TokenTDHRank[];

  @Column({ type: 'int', nullable: false })
  nextgen_balance!: number;

  @Column({ type: 'int', nullable: false })
  boosted_nextgen_tdh!: number;

  @Column({ type: 'int', nullable: false })
  nextgen_tdh!: number;

  @Column({ type: 'int', nullable: false })
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

export class BaseConsolidatedTDH extends BaseTDH {
  @Column({ type: 'varchar', length: 500 })
  @Index()
  consolidation_display!: string;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'double', nullable: false, default: 0 })
  boosted_tdh_rate!: number;

  @Column({ type: 'json', nullable: false })
  wallets?: any;
}

@Entity(CONSOLIDATED_WALLETS_TDH_TABLE)
@Index('idx_tc_c_key_boost', ['consolidation_key', 'boost'])
export class ConsolidatedTDH extends BaseConsolidatedTDH {}

@Entity(HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE)
export class HistoricConsolidatedTDH extends BaseConsolidatedTDH {}

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

  @Column({ type: 'int', nullable: false })
  tdh!: number;

  @Column({ type: 'int', nullable: false })
  boost!: number;

  @Column({ type: 'int', nullable: false })
  boosted_tdh!: number;

  @Column({ type: 'int', nullable: false })
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

  @Column({ type: 'varchar', length: 200, nullable: true })
  merkle_root!: string | null;
}

export class BaseTDHEditionsFields {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @PrimaryColumn({ type: 'int', nullable: false })
  edition_id!: number;

  @Column({ type: 'int', nullable: false })
  balance!: number;

  @Column({ type: 'int', nullable: false })
  days_held!: number;

  @Column({ type: 'double', nullable: false })
  hodl_rate!: number;
}

@Entity(TDH_EDITIONS_TABLE)
@Index(['wallet', 'hodl_rate'])
export class TDHEditions extends BaseTDHEditionsFields {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

@Entity(CONSOLIDATED_TDH_EDITIONS_TABLE)
export class ConsolidatedTDHEditions extends BaseTDHEditionsFields {
  @Index()
  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_key!: string;
}

export interface TokenTDH {
  id: number;
  balance: number;
  hodl_rate: number;
  tdh: number;
  tdh__raw: number;
  days_held_per_edition: number[];
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
  [key: `memes_szn${number}`]: BoostInfo;
  memes_genesis: BoostInfo;
  memes_nakamoto: BoostInfo;
  gradients: BoostInfo;
}
