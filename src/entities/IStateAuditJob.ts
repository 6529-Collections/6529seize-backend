import { Column, Entity, PrimaryColumn } from 'typeorm';
import { STATE_AUDIT_JOBS_TABLE } from '@/constants';

export type StateAuditJobState = 'pending' | 'applied' | 'failed';

/**
 * One reviewed state-audit manifest bound to one apply job. The row is the
 * idempotency record: `next_index` advances in the same transaction as each
 * repair unit, so a rerun resumes exactly where the last commit left off.
 */
@Entity(STATE_AUDIT_JOBS_TABLE)
export class StateAuditJobEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  job_id!: string;

  @Column({ type: 'varchar', length: 64 })
  plan_digest!: string;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  from_block!: number;

  @Column({ type: 'int' })
  to_block!: number;

  /** Canonical JSON of the reviewed manifest exactly as it was approved. */
  @Column({ type: 'json' })
  manifest_json!: string;

  /** Canonical JSON of the ledger rows read on the write pool when the job was created. */
  @Column({ type: 'json' })
  before_image_json!: string;

  @Column({ type: 'varchar', length: 20 })
  state!: StateAuditJobState;

  @Column({ type: 'int', default: 0 })
  next_index!: number;

  @Column({ type: 'int', default: 0 })
  applied_units!: number;

  @Column({ type: 'datetime' })
  created_at!: Date;

  @Column({ type: 'datetime' })
  updated_at!: Date;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;
}
