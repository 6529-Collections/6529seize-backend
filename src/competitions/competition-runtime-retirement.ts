import { createHash } from 'node:crypto';
import {
  COMPETITIONS_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { transferCompetitionRetirementHistory } from './competition-retirement-history';
import { transferRetainedCompetitionDistributions } from './competition-retirement-distributions';
import { transferRetainedCompetitionLeaderboardPublication } from './competition-retirement-leaderboard';
import { withCompetitionSchemaConnection } from './competition-schema';
import { isCompetitionRuntimeRetired } from './competition-runtime-retirement-state';
import { installLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import type { SqlExecutor } from '@/sql-executor';
import { assertWaveHubConfigurationParity } from '@/waves/wave-hub-configuration-preparation';

// The old trigger installer is retired. Only exact names from its frozen v1
// namespace can be disabled here; unrelated application triggers are preserved.
const captureSources = [
  'drops_parts',
  'drop_medias',
  'drop_attachments',
  'drops_metadatas',
  'drops_referenced_nfts',
  'drops_mentions',
  'drop_mentioned_waves',
  'drop_mentioned_groups',
  'waves',
  'wave_outcomes',
  'wave_outcome_distribution_items',
  'wave_voting_credit_nfts',
  'drops',
  'waves_decision_pauses',
  'wave_decisions',
  'wave_decision_winner_drops',
  'drop_voter_states',
  'drops_votes_credit_spendings',
  'drop_ranks',
  'wave_leaderboard_entries',
  'drop_real_vote_in_time',
  'drop_real_voter_vote_in_time',
  'winner_drop_voter_votes'
] as const;
const captureNames = new Set(
  captureSources.flatMap((table) =>
    ['INSERT', 'UPDATE', 'DELETE'].map(
      (operation) =>
        `competition_capture_${createHash('sha256').update(`legacy-migration-capture-v1:${table}:${operation}`).digest('hex').slice(0, 16)}`
    )
  )
);

export async function disableRetiredCompetitionCapture(
  db: SqlExecutor
): Promise<number> {
  return withCompetitionSchemaConnection(db, async ({ connection }) => {
    const options = { wrappedConnection: connection };
    const rows = await db.execute<{ TRIGGER_NAME: string }>(
      "select TRIGGER_NAME from information_schema.TRIGGERS where TRIGGER_SCHEMA=database() and TRIGGER_NAME like 'competition_capture_%'",
      {},
      options
    );
    if (rows.some((row) => !captureNames.has(row.TRIGGER_NAME)))
      throw new Error(
        'Unrecognized competition capture trigger; inspect before retiring'
      );
    for (const row of rows) {
      await db.execute(
        `drop trigger if exists \`${row.TRIGGER_NAME}\``,
        {},
        options
      );
    }
    return rows.length;
  });
}

/** Explicit one-time transition, never invoked by ordinary API/workers or sync.
 * Existing rows and schema remain intact for the separate physical retirement. */
export async function retireLegacyCompetitionRuntime(db: SqlExecutor) {
  if (await isCompetitionRuntimeRetired(db)) {
    const disabledTriggers = await disableRetiredCompetitionCapture(db);
    await installLegacyCompetitionGetFacade(db);
    return {
      already_retired: true,
      history: [],
      distribution_history: [],
      leaderboard_publication: [],
      disabled_triggers: disabledTriggers
    };
  }
  const unmigrated = await db.execute<{ id: string }>(
    `select w.id from ${WAVES_TABLE} w left join ${COMPETITIONS_TABLE} c on c.wave_id=w.id and c.legacy_wave_id=w.id where w.type in ('RANK','APPROVE') and (c.id is null or c.storage_mode<>'NATIVE') limit 1`,
    {}
  );
  if (unmigrated.length)
    throw new Error('Live original competition is not native');
  const pending = await db.execute<{ id: string }>(
    `select id from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where completed_at is null limit 1`,
    {}
  );
  if (pending.length)
    throw new Error(
      'Drain pending legacy execution effects before retiring runtime'
    );
  // Accepted CHAT policies have a live native shared-hub home before any view
  // changes. This comparison fails with field/count-only diagnostics.
  await assertWaveHubConfigurationParity(db);
  const history = await transferCompetitionRetirementHistory(db);
  const distributionHistory =
    await transferRetainedCompetitionDistributions(db);
  const leaderboardPublication =
    await transferRetainedCompetitionLeaderboardPublication(db);
  const disabledTriggers = await disableRetiredCompetitionCapture(db);
  await installLegacyCompetitionGetFacade(db);
  return {
    already_retired: false,
    history,
    distribution_history: distributionHistory,
    leaderboard_publication: leaderboardPublication,
    disabled_triggers: disabledTriggers
  };
}
