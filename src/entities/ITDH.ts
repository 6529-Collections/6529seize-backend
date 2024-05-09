import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';
import { BlockEntity } from './IBlock';

@Entity(TDH_BLOCKS_TABLE)
export class TDHBlock extends BlockEntity {}

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

@Entity(CONSOLIDATED_WALLETS_TDH_TABLE)
export class ConsolidatedTDH extends BaseTDH {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;
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
