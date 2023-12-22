import { Entity, PrimaryColumn, Column } from 'typeorm';
import { TDH_GLOBAL_HISTORY_TABLE, TDH_HISTORY_TABLE } from '../constants';

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
