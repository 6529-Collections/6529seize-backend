import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { REP_RATING_REMOVALS_TABLE } from '@/constants/db-tables';

/**
 * One row per REP rating deleted by the REP ratings removal job
 * (src/rep-ratings-removal): the rating's key and its value before. Written
 * in the same transaction as the delete, so it is the job's audit and undo
 * record.
 *
 * `recomputed_at` is set once the target's identity (REP and Level) has been
 * recomputed after the delete. A run that stops in between leaves it null,
 * and the next run recomputes those targets first.
 *
 * The key columns match `ratings` (utf8_bin), so the job compares them with
 * ratings keys directly.
 */
@Entity(REP_RATING_REMOVALS_TABLE)
@Index('idx_rep_rating_removals_pending', [
  'rater_profile_id',
  'recomputed_at',
  'matter_category',
  'matter_target_id'
])
export class RepRatingRemovalEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, collation: 'utf8_bin' })
  rater_profile_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100, collation: 'utf8_bin' })
  matter_category!: string;
  @PrimaryColumn({ type: 'varchar', length: 50, collation: 'utf8_bin' })
  matter_target_id!: string;
  @Column({ type: 'int' })
  old_rating!: number;
  @Column({ type: 'bigint' })
  removed_at!: number;
  @Column({ type: 'bigint', nullable: true, default: null })
  recomputed_at!: number | null;
}
