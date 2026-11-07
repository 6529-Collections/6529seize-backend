import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_WRITE_OUTBOX_TABLE } from '@/constants';

/**
 * Work a drop write owes after its commit (waves plan 1.8): notifications
 * and push, metric rollups, wave metrics and the score dirty mark. The row is
 * written in the drop's own transaction, so the work is never lost, and is
 * deleted in the same transaction that does the work, so it runs once.
 */
@Entity(DROP_WRITE_OUTBOX_TABLE)
@Index('idx_drop_write_outbox_created_at', ['created_at'])
export class DropWriteOutboxEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Index('idx_drop_write_outbox_drop_id')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly author_id!: string;

  /** CREATE or UPDATE. */
  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly operation!: string;

  @Column({ type: 'json', nullable: false })
  readonly payload!: unknown;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  /** Lease start of the processor currently holding the row, if any. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly claimed_at!: number | null;

  /** Fencing token: only its holder may delete the row with the work. */
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly claim_token!: string | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly last_error!: string | null;

  /**
   * Set once the row has used up its attempts: the sweeper stops retrying it
   * and reports it once. Reset `attempts` and this to retry it.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly quarantined_at!: number | null;
}
