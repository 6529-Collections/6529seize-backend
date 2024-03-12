import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  OWNERS_BALANCES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE
} from '../constants';

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
}

@Entity({ name: OWNERS_BALANCES_MEMES_TABLE })
export class OwnerBalancesMemes extends OwnerBalancesMemesBase {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

@Entity({ name: CONSOLIDATED_OWNERS_BALANCES_TABLE })
export class ConsolidatedOwnerBalances extends OwnerBalancesBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}

@Entity({ name: CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE })
export class ConsolidatedOwnerBalancesMemes extends OwnerBalancesMemesBase {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;
}
