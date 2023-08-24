import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_HISTORY_TABLE,
  TDH_GLOBAL_HISTORY_TABLE,
  WALLETS_TDH_TABLE
} from '../constants';

@Entity(WALLETS_TDH_TABLE)
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
  tdh_rank_memes_szn1!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn2!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn3!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn4!: number;

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

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season1!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season2!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season3!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season1__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season2__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season3__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season4__raw!: number;

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

export interface TDHENS extends TDH {
  ens: string;
}

@Entity(CONSOLIDATED_WALLETS_TDH_TABLE)
export class ConsolidatedTDH {
  @Column({ type: 'datetime' })
  date!: Date;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  consolidation_display!: string;

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
  tdh_rank_memes_szn1!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn2!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn3!: number;

  @Column({ type: 'int', nullable: false })
  tdh_rank_memes_szn4!: number;

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

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season1!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season2!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season3!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  unique_memes_season4!: number;

  @Column({ type: 'int', nullable: false })
  boosted_memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh__raw!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season1!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season1__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season2!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season2__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season3!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season3__raw!: number;

  @Column({ type: 'double', nullable: false })
  boosted_memes_tdh_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance_season4!: number;

  @Column({ type: 'int', nullable: false })
  memes_tdh_season4__raw!: number;

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
  id: string;
  balance: number;
  tdh: number;
  tdh__raw: number;
}
