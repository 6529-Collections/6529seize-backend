import {
  CHAIN_CLAIM_BUILDS_TABLE,
  CHAIN_DOCS_TABLE,
  CHAIN_EVENTS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITIONS_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
  DELETED_DROPS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  WAVES_CHAIN_MIRROR_EVENTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVES_CHAIN_INDEX_STATE_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  WAVES_TABLE,
  ACTIVITY_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVE_SCORE_REFRESH_REQUESTS_TABLE,
  WAVES_ARCHIVE_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVES_METADATA_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE
} from '@/constants';
import { legacyCompetitionEntryId } from '@/competitions/competition-id';
import { DropType } from '@/entities/IDrop';
import { WaveCreditScope, WaveCreditType, WaveType } from '@/entities/IWave';
import { SqlExecutor } from '@/sql-executor';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  INDEX_TABLES,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import {
  decisionRow,
  entryRow,
  leaderboardEntryRows,
  leaderboardRow,
  resultRow,
  voteRow
} from '@/waves-chain-index/waves-chain-index.rows';
import { IDENTITY_CHAIN_PRINCIPALS } from '@/waves-chain-mirror/waves-chain-mirror.db';
import {
  IdentityChainMirrorDb,
  NO_RETRY
} from '@/identity-chain-mirror/identity-chain-mirror.db';
import * as mysql from 'mysql';

/**
 * Database fixtures for the waves chain mirror: the identity mirror's
 * principal map, the chain index's rows as the index writes them, and an
 * imported decision on 6529.io (a wave, its primary competition, entry
 * drops and their entries).
 */

/** The identity mirror's table, as its entity makes it (not on this branch). */
export async function ensurePrincipalMap(db: SqlExecutor): Promise<void> {
  await db.execute(
    `create table if not exists ${IDENTITY_CHAIN_PRINCIPALS} (
       principal_id varchar(66) not null primary key,
       profile_id varchar(50) not null,
       origin varchar(20) not null,
       created_at bigint not null,
       unique key identity_chain_principals_profile_id_idx (profile_id))`
  );
}

/**
 * The identity mirror's state as of a run that stands at chain height
 * `height` (identityRowsReached holds for it and below): a full sync
 * ended, the feed and the bindings followed past it, nothing to retry.
 * Null: no state row (the identity mirror never ran).
 */
export async function identityMirrorAt(
  db: SqlExecutor,
  height: number | null
): Promise<void> {
  const identity = new IdentityChainMirrorDb(() => db);
  if (height === null) {
    await db.execute(`delete from ${IDENTITY_CHAIN_MIRROR_STATE_TABLE}`);
    return;
  }
  await identity.saveState(
    {
      next_height: height + 1,
      sync_from_height: null,
      sync_phase: null,
      sync_after: null,
      last_full_sync_at: 1,
      bindings_next_height: height + 1,
      chain_id: null,
      placeholders_at: null,
      bindings_exact: true,
      levels_tdh_day: null,
      level_sweep_day: null,
      level_sweep_after: null,
      levels_day_height: null,
      sync_use_case: null,
      sync_wallet_after: null,
      pin_floor: null,
      off_chain_after: null,
      events_next_height: null,
      events_rebuild_height: null,
      events_rebuild_after: null,
      events_gone_at: null,
      events_stuck_runs: 0,
      retry: NO_RETRY
    },
    1
  );
}

export async function mapPrincipals(
  db: SqlExecutor,
  map: Record<string, string>
): Promise<void> {
  for (const [principal, profile] of Object.entries(map)) {
    await db.execute(
      `insert into ${IDENTITY_CHAIN_PRINCIPALS}
         (principal_id, profile_id, origin, created_at)
       values (:principal, :profile, 'LEGACY', 1)`,
      { principal, profile }
    );
  }
}

/** The chain's API objects of one decision, as the index stores them. */
export interface ChainDecisionObjects {
  readonly decision: ChainObject;
  readonly entries?: ChainObject[];
  readonly votes?: ChainObject[];
  /** The live leaderboard (published decisions). */
  readonly leaderboard?: ChainObject | null;
  readonly results?: ChainObject[];
}

/** Writes a decision's rows as the index does, at `height`. */
export async function seedChainDecision(
  index: WavesChainIndexDb,
  objects: ChainDecisionObjects,
  height: number,
  generation = 1
): Promise<void> {
  const stamp = { height, generation };
  const decisionId = String(objects.decision.decisionId).toLowerCase();
  await index.upsert('decisions', [decisionRow(objects.decision)], stamp);
  await index.replaceChildren(
    'entries',
    'decision_id',
    decisionId,
    (objects.entries ?? []).map(entryRow),
    stamp
  );
  await index.replaceChildren(
    'votes',
    'decision_id',
    decisionId,
    (objects.votes ?? []).map(voteRow),
    stamp
  );
  await index.replaceChildren(
    'results',
    'decision_id',
    decisionId,
    (objects.results ?? []).map((r) => resultRow(decisionId, r)),
    stamp
  );
  if (objects.leaderboard) {
    await index.upsert(
      'leaderboards',
      [leaderboardRow(decisionId, objects.leaderboard)],
      stamp
    );
  } else {
    await index.remove('leaderboards', [{ decision_id: decisionId }]);
  }
  await index.replaceChildren(
    'leaderboardRows',
    'decision_id',
    decisionId,
    objects.leaderboard
      ? leaderboardEntryRows(decisionId, objects.leaderboard)
      : [],
    stamp
  );
}

/** An imported decision on 6529.io: its wave, competition, drops, entries. */
export async function seedImportedCompetition(
  db: SqlExecutor,
  input: {
    waveId: string;
    authorId: string;
    dropIds: readonly string[];
    timeLockMs?: number | null;
    nextDecisionTime?: number | null;
    createdAt?: number;
  }
): Promise<{ competitionId: string; entryIds: Record<string, string> }> {
  const createdAt = input.createdAt ?? 1_700_000_000_000;
  const wave = aWave(
    {
      type: WaveType.RANK,
      created_by: input.authorId,
      created_at: createdAt,
      updated_at: createdAt,
      voting_credit_type: WaveCreditType.TDH,
      voting_credit_scope: WaveCreditScope.WAVE,
      time_lock_ms: input.timeLockMs ?? null,
      next_decision_time: input.nextDecisionTime ?? null,
      decisions_strategy: input.nextDecisionTime
        ? ({
            first_decision_time: input.nextDecisionTime,
            subsequent_decisions: [86_400_000],
            is_rolling: true
          } as any)
        : null
    },
    { id: input.waveId, name: 'A test wave', serial_no: 1 }
  );
  const seed = withWaves([wave]);
  for (const row of seed.rows) {
    const columns = Object.keys(row);
    await db.execute(
      `insert into ${seed.table} (${columns.map((c) => mysql.escapeId(c)).join(',')})
       values (${columns.map((c) => mysql.escape(normalize(row[c]))).join(',')})`
    );
  }
  const competition = await seedNativeOriginalPrimaryFixture(wave, {}, db);
  // Held, as the waves freeze holds every decision from 6529.io's runtime.
  await db.execute(
    `update ${COMPETITIONS_TABLE} set execution_mode = 'DISABLED' where id = :id`,
    { id: competition.id }
  );
  const entryIds: Record<string, string> = {};
  for (let i = 0; i < input.dropIds.length; i++) {
    const dropId = input.dropIds[i];
    await db.execute(
      `insert into ${DROPS_TABLE}
         (id, author_id, drop_type, wave_id, created_at, updated_at, title,
          parts_count, signature, is_additional_action_promised,
          hide_link_preview, collapse_replies)
       values (:id, :author, :type, :wave, :at, :at, null, 1, null, 0, 0, 0)`,
      {
        id: dropId,
        author: input.authorId,
        type: DropType.PARTICIPATORY,
        wave: input.waveId,
        at: createdAt + i
      }
    );
    const entryId = legacyCompetitionEntryId(competition.id, dropId);
    entryIds[dropId] = entryId;
    await db.execute(
      `insert into ${COMPETITION_ENTRIES_TABLE}
         (id, competition_id, wave_id, drop_id, submitter_id, status,
          config_version, submitted_at)
       values (:id, :competitionId, :wave, :dropId, :author, 'ACTIVE', 1, :at)`,
      {
        id: entryId,
        competitionId: competition.id,
        wave: input.waveId,
        dropId,
        author: input.authorId,
        at: createdAt + i
      }
    );
  }
  return { competitionId: competition.id, entryIds };
}

/** A vote 6529.io holds (before the switch). */
export async function seedTargetVote(
  db: SqlExecutor,
  vote: {
    id: string;
    competitionId: string;
    entryId: string;
    voterProfileId: string;
    value: number;
    at?: number;
  }
): Promise<void> {
  await db.execute(
    `insert into ${COMPETITION_VOTES_TABLE}
       (id, competition_id, entry_id, voter_profile_id, value, credit_spent,
        created_at, updated_at)
     values (:id, :competitionId, :entryId, :voterProfileId, :value,
        abs(:value), :at, :at)`,
    { ...vote, at: vote.at ?? 1_700_000_000_000 }
  );
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Every row of these tables, in a stable order (idempotence checks). */
export async function dumpTables(
  db: SqlExecutor,
  tables: readonly string[]
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    const rows = await db.execute<Record<string, unknown>>(
      `select * from ${mysql.escapeId(table)}`
    );
    out[table] = rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v])
          )
        )
      )
      .sort((a, b) => (a < b ? -1 : Number(a > b)));
  }
  return out;
}

/**
 * Empties the tables the mirror's database tests touch (seconds, where a
 * whole-database reset takes minutes on a test database).
 */
export async function clearMirrorTables(db: SqlExecutor): Promise<void> {
  await ensurePrincipalMap(db);
  const tables = [
    ...Object.values(INDEX_TABLES).map((t) => t.name),
    CHAIN_EVENTS_TABLE,
    CHAIN_CLAIM_BUILDS_TABLE,
    WAVES_CHAIN_INDEX_STATE_TABLE,
    WAVES_CHAIN_MIRROR_STATE_TABLE,
    IDENTITY_CHAIN_MIRROR_STATE_TABLE,
    CHAIN_DOCS_TABLE,
    IDENTITY_CHAIN_PRINCIPALS,
    WAVES_TABLE,
    COMPETITIONS_TABLE,
    COMPETITION_CONFIG_VERSIONS_TABLE,
    COMPETITION_CAPABILITIES_TABLE,
    COMPETITION_ENTRIES_TABLE,
    COMPETITION_VOTES_TABLE,
    COMPETITION_ENTRY_RUNTIME_TABLE,
    COMPETITION_LEADERBOARD_ENTRIES_TABLE,
    COMPETITION_DECISIONS_TABLE,
    COMPETITION_DECISION_WINNERS_TABLE,
    COMPETITION_WINNER_VOTES_TABLE,
    COMPETITION_OUTCOME_AWARDS_TABLE,
    COMPETITION_LIFECYCLE_EVENTS_TABLE,
    COMPETITION_OUTBOX_TABLE,
    COMPETITION_VOTE_HISTORY_TABLE,
    COMPETITION_SCORE_HISTORY_TABLE,
    WAVES_CHAIN_MIRROR_EVENTS_TABLE,
    CHAIN_ENTRY_HOLDS_TABLE,
    PROFILES_ACTIVITY_LOGS_TABLE,
    DELETED_DROPS_TABLE,
    DROPS_TABLE,
    DROPS_PARTS_TABLE,
    DROP_MEDIA_TABLE,
    DROP_METADATA_TABLE,
    DROPS_MENTIONS_TABLE,
    DROP_REFERENCED_NFTS_TABLE,
    DROP_MENTIONED_WAVES_TABLE,
    DROP_MENTIONED_GROUPS_TABLE,
    DROP_RELATIONS_TABLE,
    WAVE_METRICS_TABLE,
    WAVE_DROPPER_METRICS_TABLE,
    WAVES_CHAIN_MIRROR_GROUPS_TABLE,
    WAVES_CHAIN_MIRROR_WAVES_TABLE,
    WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
    COMPETITION_OUTCOMES_TABLE,
    COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
    USER_GROUPS_TABLE,
    PROFILE_GROUPS_TABLE,
    PROFILE_GROUP_CHANGES,
    WAVES_ARCHIVE_TABLE,
    WAVES_METADATA_TABLE,
    IDENTITY_SUBSCRIPTIONS_TABLE,
    WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
    ACTIVITY_EVENTS_TABLE,
    IDENTITY_NOTIFICATIONS_TABLE,
    WAVE_SCORE_REFRESH_REQUESTS_TABLE,
    IDENTITIES_TABLE,
    ADDRESS_CONSOLIDATION_KEY,
    CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE
  ];
  for (const table of tables) {
    await db.execute(`delete from ${mysql.escapeId(table)}`);
  }
}
