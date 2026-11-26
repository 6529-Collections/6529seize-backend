import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SIGNED_RECORD_LOG_SEGMENTS_TABLE
} from '@/constants';

/**
 * Entries waiting for the open segment of the interim record log. A queue:
 * a segment closes every 5 minutes and takes them.
 */
@Entity(SIGNED_RECORD_LOG_ENTRIES_TABLE)
@Index('idx_signed_record_log_entries_open', ['chain', 'segment_seq', 'id'])
export class SignedRecordLogEntryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  readonly id!: number;

  @Column({ type: 'varchar', length: 8, nullable: false })
  readonly chain!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly lane!: string;

  // Canonical JSON of the entry.
  @Column({ type: 'mediumtext', nullable: false })
  readonly entry!: string;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', unsigned: true, nullable: true, default: null })
  readonly segment_seq!: number | null;
}

/**
 * Closed segments of the interim record log, per chain. An index of the
 * head drops: a rebuild walks the heads in the records wave instead.
 */
@Entity(SIGNED_RECORD_LOG_SEGMENTS_TABLE)
export class SignedRecordLogSegmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 8, nullable: false })
  readonly chain!: string;

  @PrimaryColumn({ type: 'bigint', unsigned: true, nullable: false })
  readonly seq!: number;

  @Column({ type: 'char', length: 64, nullable: false })
  readonly sha256!: string;

  @Column({ type: 'varchar', length: 128, nullable: false })
  readonly cid!: string;

  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly prev!: string | null;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly entries!: number;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly opened_at!: number;

  @Column({ type: 'bigint', unsigned: true, nullable: false })
  readonly closed_at!: number;

  // The file until it is on Arweave.
  @Column({ type: 'longblob', nullable: true, default: null })
  readonly content!: Buffer | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly head_drop_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  readonly arweave_tx!: string | null;

  // The drop that lists this segment's Arweave id.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly archive_drop_id!: string | null;
}
