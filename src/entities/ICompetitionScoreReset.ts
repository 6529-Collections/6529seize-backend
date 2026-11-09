import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  COMPETITION_SCORE_RESETS_TABLE,
  COMPETITION_SCORE_RESET_STATE_TABLE
} from '@/constants/db-tables';

/** The latest full-content reset; the outbox remains the audit source. */
@Entity(COMPETITION_SCORE_RESETS_TABLE)
export class CompetitionScoreResetEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  readonly content_revision!: number | null;
  @Column({ type: 'bigint', unsigned: true })
  readonly vote_history_sequence!: number;
  @Column({ type: 'bigint', unsigned: true })
  readonly aggregate_history_sequence!: number;
  @Column({ type: 'bigint', unsigned: true })
  readonly voter_history_sequence!: number;
  @Column({ type: 'bigint' })
  readonly source_created_at!: number;
  @Column({ type: 'varchar', length: 36 })
  readonly source_id!: string;
}

/** Explicit operator cutover: absence never means that backfill is complete. */
@Entity(COMPETITION_SCORE_RESET_STATE_TABLE)
export class CompetitionScoreResetStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 36, default: '' })
  readonly after_competition_id!: string;
  @Column({ type: 'boolean', default: false })
  readonly backfill_complete!: boolean;
  @Column({ type: 'boolean', default: false })
  readonly reads_enabled!: boolean;
}
