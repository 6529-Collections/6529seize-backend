import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';
import { DISTRIBUTION_NORMALIZED_TABLE, DISTRIBUTION_TABLE } from '@/constants';

export interface AllowlistNormalizedEntry {
  phase: string;
  spots: number;
  spots_airdrop: number;
  spots_allowlist: number;
}

@Entity({ name: DISTRIBUTION_TABLE })
@Index(['wallet', 'phase', 'card_id', 'contract'], { unique: true })
export class Distribution {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at!: Date;

  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  card_id!: number;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'varchar', length: 50 })
  phase!: string;

  @Column({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'int', default: 0 })
  wallet_tdh!: number;

  @Column({ type: 'int', default: 0 })
  wallet_balance!: number;

  @Column({ type: 'int', default: 0 })
  wallet_unique_balance!: number;

  @Column({ type: 'int' })
  count!: number;

  @Column({ type: 'int', default: 0 })
  count_airdrop!: number;

  @Column({ type: 'int', default: 0 })
  count_allowlist!: number;
}

@Entity({ name: DISTRIBUTION_NORMALIZED_TABLE })
@Index('idx_wallet_contract_cardid', ['wallet', 'contract', 'card_id'])
@Index('idx_cardname', ['card_name', 'contract', 'card_id'])
@Index('idx_mintdate', ['mint_date', 'contract', 'card_id'])
@Index('idx_contract_cardid', ['contract', 'card_id'])
@Index('idx_missing_info', ['is_missing_info', 'contract', 'card_id'])
export class DistributionNormalized {
  @PrimaryColumn({ type: 'bigint' })
  card_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'text' })
  wallet_display!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  card_name!: string;

  @Column({ type: 'timestamp', nullable: true })
  mint_date!: Date;

  @Column({ type: 'int' })
  airdrops!: number;

  @Column({ type: 'int' })
  total_spots!: number;

  @Column({ type: 'int' })
  total_count!: number;

  @Column({ type: 'int' })
  minted!: number;

  @Column({ type: 'json', nullable: true })
  allowlist!: AllowlistNormalizedEntry[] | null;

  @Column({ type: 'json', nullable: true })
  phases!: string[] | null;

  @Column({
    type: 'tinyint',
    name: 'is_missing_info',
    insert: false,
    update: false,
    generatedType: 'STORED',
    asExpression: `card_name IS NULL OR card_name = '' OR mint_date IS NULL`,
    nullable: false
  })
  is_missing_info!: boolean;
}
