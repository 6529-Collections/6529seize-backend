import type { SqlExecutor } from '@/sql-executor';
import { RETIRED_WAVE_COMPETITION_COLUMNS } from './legacy-competition-get-facade';

/** Exact physical retirement boundary. Compatibility view names are permanent. */
export const RETIRED_COMPETITION_TABLES = [
  'drop_voter_states',
  'drops_votes_credit_spendings',
  'drop_ranks',
  'drop_real_vote_in_time',
  'drop_real_voter_vote_in_time',
  'winner_drop_voter_votes',
  'wave_leaderboard_entries',
  'wave_decisions',
  'wave_decision_winner_drops',
  'wave_outcomes',
  'wave_outcome_distribution_items',
  'waves_decision_pauses',
  'wave_voting_credit_nfts',
  'wave_voting_credit_nfts_archive',
  'competition_migrations',
  'competition_migration_changes',
  'competition_migration_audits',
  'competition_migration_environments',
  'competition_legacy_mirror_permits',
  'competition_legacy_execution_effects',
  'competition_parity_observations',
  // Audited historical copies of the same obsolete vote storage. They have
  // no application, view, routine, event, trigger or foreign-key consumers.
  'dr_vote_backup_20250506',
  'drv_vote_backup_20250506',
  'drop_real_vote_in_time_xxx',
  'drop_voter_states_backup_20250506',
  'winner_drop_voter_votes_bckup_15_07_25_1'
] as const;

export const RETIRED_COMPETITION_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  waves: RETIRED_WAVE_COMPETITION_COLUMNS,
  waves_archive: RETIRED_WAVE_COMPETITION_COLUMNS.filter(
    (column) => column !== 'next_decision_time'
  ),
  competitions: ['storage_mode']
};

/** Full sync must never choose the destructive rollout boundary. Before the
 * reviewed operator deletion use maintenance; fresh/already-clean schemas sync
 * normally. Unregistered retired tables are ignored by TypeORM. */
export async function assertCompetitionSchemaSyncSafe(
  db: SqlExecutor
): Promise<void> {
  const columns = await db.execute<{ table_name: string; column_name: string }>(
    `select TABLE_NAME as table_name,COLUMN_NAME as column_name
     from information_schema.COLUMNS
     where TABLE_SCHEMA=database() and TABLE_NAME in (:tables)`,
    { tables: Object.keys(RETIRED_COMPETITION_COLUMNS) }
  );
  if (
    columns.some(({ table_name, column_name }) =>
      RETIRED_COMPETITION_COLUMNS[table_name].includes(column_name)
    )
  ) {
    throw new Error(
      'Retired competition columns require explicit backed-up operator cleanup before full schema synchronization; use maintenance during rollout'
    );
  }
}
