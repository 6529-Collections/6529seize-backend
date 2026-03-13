import { ART_CURATION_TOKEN_WATCHES_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ArtCurationTokenWatchStatus {
  ACTIVE = 'ACTIVE',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED'
}

@Entity(ART_CURATION_TOKEN_WATCHES_TABLE)
@Index('idx_art_curation_token_watches_status_last_checked', [
  'status',
  'last_checked_block'
])
@Index('idx_art_curation_token_watches_lookup', [
  'wave_id',
  'chain',
  'contract',
  'token_id',
  'status'
])
@Index(
  'idx_art_curation_token_watches_active_dedupe_key',
  ['active_dedupe_key'],
  {
    unique: true
  }
)
export class ArtCurationTokenWatchEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly canonical_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly chain!: string;

  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly contract!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly token_id!: string;

  @Column({ type: 'varchar', length: 280, nullable: true })
  readonly active_dedupe_key!: string | null;

  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly owner_at_submission!: string;

  @Column({
    type: 'varchar',
    length: 32,
    nullable: false,
    default: ArtCurationTokenWatchStatus.ACTIVE
  })
  readonly status!: ArtCurationTokenWatchStatus;

  @Column({ type: 'bigint', nullable: false })
  readonly start_block!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly start_time!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly last_checked_block!: number;

  @Column({ type: 'bigint', nullable: true })
  readonly locked_at!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly resolved_at!: number | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  readonly trigger_tx_hash!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly trigger_block_number!: number | null;

  @Column({ type: 'int', nullable: true })
  readonly trigger_log_index!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly trigger_time!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly trigger_price_raw!: string | null;

  @Column({ type: 'double', nullable: true })
  readonly trigger_price!: number | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  readonly trigger_price_currency!: string | null;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly created_at!: number;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly updated_at!: number;
}
