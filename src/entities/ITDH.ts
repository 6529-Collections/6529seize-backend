import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('tdh')
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
