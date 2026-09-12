import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  WALLET_TRANSFER_ANALYSIS_STATES_TABLE,
  WALLET_TRANSFER_PAIR_DAYS_TABLE,
  WALLET_TRANSFER_WALLET_DAYS_TABLE
} from '@/constants';

@Entity(WALLET_TRANSFER_PAIR_DAYS_TABLE)
@Index('idx_wallet_transfer_pair_report', [
  'contract',
  'day_start',
  'from_address',
  'to_address'
])
export class WalletTransferPairDailyEntity {
  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @PrimaryColumn({ type: 'int' })
  readonly bucket_start!: number;

  @PrimaryColumn({ type: 'bigint' })
  readonly day_start!: number;

  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly from_address!: string;

  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly to_address!: string;

  @Column({ type: 'bigint' })
  readonly transfer_count!: number;

  @Column({ type: 'bigint' })
  readonly token_count!: number;

  @Column({ type: 'bigint' })
  readonly first_transfer_at!: number;

  @Column({ type: 'bigint' })
  readonly last_transfer_at!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly sample_transaction!: string;
}

@Entity(WALLET_TRANSFER_WALLET_DAYS_TABLE)
@Index('idx_wallet_transfer_wallet_report', ['contract', 'day_start', 'wallet'])
export class WalletTransferWalletDailyEntity {
  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @PrimaryColumn({ type: 'int' })
  readonly bucket_start!: number;

  @PrimaryColumn({ type: 'bigint' })
  readonly day_start!: number;

  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly wallet!: string;

  @Column({ type: 'bigint' })
  readonly outbound_count!: number;

  @Column({ type: 'bigint' })
  readonly inbound_count!: number;

  @Column({ type: 'bigint' })
  readonly outbound_token_count!: number;

  @Column({ type: 'bigint' })
  readonly inbound_token_count!: number;
}

@Entity(WALLET_TRANSFER_ANALYSIS_STATES_TABLE)
export class WalletTransferAnalysisStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @Column({ type: 'int', default: -1 })
  readonly last_block!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
