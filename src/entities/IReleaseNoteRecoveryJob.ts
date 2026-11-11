import { RELEASE_NOTE_RECOVERY_JOBS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type ReleaseNoteRecoveryStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'NO_BASELINE'
  | 'REJECTED';

/** Request envelopes survive SQS retention and Redis expiration. */
@Entity(RELEASE_NOTE_RECOVERY_JOBS_TABLE)
@Index('idx_release_note_recovery_due', ['status', 'next_attempt_at'])
@Index('idx_release_note_recovery_stream', [
  'stream_key',
  'status',
  'run_number'
])
export class ReleaseNoteRecoveryJobEntity {
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly publication_id!: string;

  @Column({ type: 'char', length: 64 })
  readonly stream_key!: string;

  @Column({ type: 'varchar', length: 32 })
  readonly run_id!: string;

  @Column({ type: 'int', unsigned: true })
  readonly run_number!: number;

  @Column({ type: 'mediumtext' })
  readonly request_json!: string;

  @Column({ type: 'varchar', length: 20 })
  readonly status!: ReleaseNoteRecoveryStatus;

  @Column({ type: 'int', unsigned: true, default: 0 })
  readonly failure_count!: number;

  @Column({ type: 'bigint' })
  readonly next_attempt_at!: number;

  @Column({ type: 'text', nullable: true })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly alerted_at!: number | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
