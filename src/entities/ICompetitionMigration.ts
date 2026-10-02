import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_MIGRATION_AUDIT_TABLE,
  COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE
} from '@/constants';
import type {
  MigrationAcceptance,
  MigrationCohort,
  MigrationStage,
  MigrationState
} from '@/competitions/competition-migration-policy';

@Entity(COMPETITION_MIGRATIONS_TABLE)
export class CompetitionMigrationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 100, unique: true })
  readonly wave_id!: string;
  @Column({ type: 'varchar', length: 24 }) readonly state!: MigrationState;
  @Column({ type: 'varchar', length: 24 }) readonly cohort!: MigrationCohort;
  @Column({ type: 'varchar', length: 100 }) readonly owner!: string;
  @Column({ type: 'bigint', default: 0 }) readonly source_watermark!: number;
  @Column({ type: 'bigint', default: 0 }) readonly applied_watermark!: number;
  @Column({ type: 'bigint', default: 0 }) readonly target_watermark!: number;
  @Column({ type: 'int', nullable: true }) readonly reset_table_index!:
    | number
    | null;
  @Column({ type: 'varchar', length: 24 }) readonly stage!: MigrationStage;
  @Column({ type: 'bigint', nullable: true }) readonly next_batch_at!:
    | number
    | null;
  @Column({ type: 'bigint', default: 0 }) readonly stage_offset!: number;
  @Column({ type: 'varchar', length: 500, nullable: true })
  readonly stage_cursor!: string | null;
  @Column({ type: 'json', nullable: true }) readonly reverse_checkpoint!: {
    index: number;
    phase: 'PRUNE' | 'COPY';
    cursor: string | null;
  } | null;
  @Column({ type: 'boolean', default: false }) readonly reverse_ready!: boolean;
  @Column({ type: 'json' }) readonly completed_stages!: MigrationStage[];
  @Column({ type: 'int', default: 0 })
  readonly consecutive_full_windows!: number;
  @Column({ type: 'bigint', nullable: true }) readonly window_started_at!:
    | number
    | null;
  @Column({ type: 'bigint', nullable: true }) readonly window_duration_ms!:
    | number
    | null;
  @Column({ type: 'int', default: 0 }) readonly window_samples!: number;
  @Column({ type: 'bigint', nullable: true }) readonly last_window_end!:
    | number
    | null;
  @Column({ type: 'bigint', nullable: true }) readonly last_comparison_at!:
    | number
    | null;
  @Column({ type: 'bigint', nullable: true })
  readonly last_comparison_watermark!: number | null;
  @Column({ type: 'json', nullable: true })
  readonly acceptance!: MigrationAcceptance | null;
  @Column({ type: 'json' }) readonly exceptions!: string[];
  @Column({ type: 'bigint', nullable: true }) readonly cutover_at!:
    | number
    | null;
  @Column({ type: 'bigint', nullable: true }) readonly cutover_decision_count!:
    | number
    | null;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
}

/** Transactional after-images also preserve deletions and pruned legacy history. */
@Entity(COMPETITION_MIGRATION_CHANGES_TABLE)
@Index('idx_competition_migration_changes_watermark', [
  'competition_id',
  'watermark',
  'sequence'
])
export class CompetitionMigrationChangeEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' }) readonly sequence!: number;
  @Column({ type: 'varchar', length: 36 }) readonly competition_id!: string;
  @Column({ type: 'bigint' }) readonly watermark!: number;
  @Column({ type: 'varchar', length: 100 }) readonly source_table!: string;
  @Column({ type: 'varchar', length: 8 }) readonly operation!: string;
  @Column({ type: 'json', nullable: true }) readonly before_row!: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'json', nullable: true }) readonly after_row!: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'bigint' }) readonly occurred_at!: number;
}

@Entity(COMPETITION_MIGRATION_AUDIT_TABLE)
@Index('idx_competition_migration_audit', ['competition_id', 'created_at'])
export class CompetitionMigrationAuditEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly competition_id!: string;
  @Column({ type: 'varchar', length: 100 }) readonly actor!: string;
  @Column({ type: 'varchar', length: 48 }) readonly action!: string;
  @Column({ type: 'text' }) readonly reason!: string;
  @Column({ type: 'json' }) readonly report!: Record<string, unknown>;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}

/** Exists only inside the native owner's transaction. A crash rolls it back. */
@Entity(COMPETITION_LEGACY_MIRROR_PERMITS_TABLE)
export class CompetitionLegacyMirrorPermitEntity {
  @PrimaryColumn({ type: 'bigint' }) readonly connection_id!: number;
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'int', default: 1 }) readonly depth!: number;
}

@Entity(COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE)
@Index('idx_legacy_execution_effects_pending', [
  'completed_at',
  'competition_id'
])
export class CompetitionLegacyExecutionEffectsEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly competition_id!: string;
  @Column({ type: 'varchar', length: 100 }) readonly wave_id!: string;
  @Column({ type: 'json' }) readonly payload!: {
    claimDropId: string | null;
    pushIds: number[];
    dirtyWaveIds: string[];
  };
  @Column({ type: 'varchar', length: 36, nullable: true })
  readonly lease_token!: string | null;
  @Column({ type: 'bigint', nullable: true }) readonly lease_until!:
    | number
    | null;
  @Column({ type: 'bigint', nullable: true }) readonly completed_at!:
    | number
    | null;
  @Column({ type: 'int', default: 0 }) readonly attempts!: number;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}
