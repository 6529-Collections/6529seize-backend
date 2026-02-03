import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  OWNERS_BALANCES_MEMES_TABLE,
  OWNERS_BALANCES_TABLE
} from '@/constants';

export abstract class OwnerBalancesBase {
  @CreateDateColumn()
  created_at?: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @Column({ type: 'int', nullable: false })
  total_balance!: number;

  @Column({ type: 'int', nullable: false })
  gradients_balance!: number;

  @Column({ type: 'int', nullable: false })
  nextgen_balance!: number;

  @Column({ type: 'int', nullable: false })
  memelab_balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memelab!: number;

  @Column({ type: 'int', nullable: false })
  memes_balance!: number;

  @Column({ type: 'int', nullable: false })
  unique_memes!: number;

  @Column({ type: 'int', nullable: false })
  genesis!: number;

  @Column({ type: 'int', nullable: false })
  nakamoto!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus1!: number;

  @Column({ type: 'int', nullable: false })
  memes_cards_sets_minus2!: number;
}

export class OwnerBalancesMemesBase {
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

  @Column({ type: 'int', nullable: false })
  sets!: number;
}

@Entity({ name: OWNERS_BALANCES_TABLE })
export class OwnerBalances extends OwnerBalancesBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int' })
  block_reference!: number;
}

@Entity({ name: OWNERS_BALANCES_MEMES_TABLE })
@Index('obm_wallet_season_idx', ['wallet', 'season'])
@Index('obm_season_balance_idx', ['season', 'balance'])
export class OwnerBalancesMemes extends OwnerBalancesMemesBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

@Entity(CONSOLIDATED_OWNERS_BALANCES_TABLE)
export class ConsolidatedOwnerBalances extends OwnerBalancesBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}

@Entity(CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE)
@Index('obmc_ck_season_idx', ['consolidation_key', 'season'])
@Index('obmc_season_balance_idx', ['season', 'balance'])
export class ConsolidatedOwnerBalancesMemes extends OwnerBalancesMemesBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}
