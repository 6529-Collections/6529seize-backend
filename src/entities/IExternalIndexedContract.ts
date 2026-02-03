import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EXTERNAL_INDEXED_CONTRACTS_TABLE } from '@/constants';

export enum IndexedContractStandard {
  ERC721 = 'ERC721',
  ERC1155 = 'ERC1155',
  LEGACY_721 = 'LEGACY_721',
  UNKNOWN = 'UNKNOWN'
}

export enum IndexedContractStatus {
  WAITING_FOR_SNAPSHOTTING = 'WAITING_FOR_SNAPSHOTTING',
  SNAPSHOTTING = 'SNAPSHOTTING',
  ERROR_SNAPSHOTTING = 'ERROR_SNAPSHOTTING',
  UNINDEXABLE = 'UNINDEXABLE',
  LIVE_TAILING = 'LIVE_TAILING'
}

@Entity(EXTERNAL_INDEXED_CONTRACTS_TABLE)
@Index(['chain', 'contract'], { unique: true })
export class ExternalIndexedContractEntity {
  @PrimaryColumn({ type: 'varchar', length: 90 })
  readonly partition!: string;

  @Column({ type: 'int' })
  readonly chain!: number;

  @Column({ type: 'varchar', length: 42 })
  readonly contract!: string;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly collection_name!: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: IndexedContractStandard.UNKNOWN
  })
  readonly standard!: IndexedContractStandard;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly adapter!: string | null;

  @Column({ type: 'int', nullable: true })
  readonly total_supply!: number | null;

  @Column({ type: 'bigint', default: 0 })
  readonly indexed_since_block!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly last_indexed_block!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly safe_head_block!: number;

  @Column({ type: 'bigint', nullable: true })
  readonly last_event_time!: number | null;

  @Index()
  @Column({
    type: 'varchar',
    length: 50,
    default: IndexedContractStatus.WAITING_FOR_SNAPSHOTTING
  })
  readonly status!: IndexedContractStatus;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly snapshot_lock_owner!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly snapshot_lock_at!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly snapshot_target_block!: number | null;

  @Column({ type: 'bigint', default: 0 })
  readonly lag_blocks!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly lag_seconds!: number;

  @Column({ type: 'text', nullable: true })
  readonly error_message!: string | null;

  @Column({
    type: 'bigint'
  })
  readonly created_at!: number;

  @Column({
    type: 'bigint'
  })
  readonly updated_at!: number;
}
