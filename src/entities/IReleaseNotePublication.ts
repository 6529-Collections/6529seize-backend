import { RELEASE_NOTE_PUBLICATIONS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum ReleaseNotePublicationStatus {
  Pending = 'PENDING',
  Publishing = 'PUBLISHING',
  Completed = 'COMPLETED',
  Superseded = 'SUPERSEDED'
}

@Entity(RELEASE_NOTE_PUBLICATIONS_TABLE)
@Index(
  'uq_release_note_publication_stream_run',
  ['stream_key', 'current_run_number'],
  { unique: true }
)
@Index('idx_release_note_publication_stream_status_run', [
  'stream_key',
  'status',
  'current_run_number'
])
export class ReleaseNotePublicationEntity {
  @PrimaryColumn({ type: 'char', length: 64, nullable: false })
  readonly publication_id!: string;

  @Column({ type: 'char', length: 64, nullable: false })
  readonly stream_key!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly current_run_id!: string;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly current_run_number!: number;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly current_sha!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly previous_run_id!: string;

  @Column({ type: 'int', unsigned: true, nullable: false })
  readonly previous_run_number!: number;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly previous_sha!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: ReleaseNotePublicationStatus;

  @Column({ type: 'int', unsigned: true, nullable: true, default: null })
  readonly total_parts!: number | null;

  @Column({ type: 'int', unsigned: true, nullable: false, default: 1 })
  readonly next_part!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly last_drop_id!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
}
