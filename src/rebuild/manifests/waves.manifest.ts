import { MODERATION_ACTIONS } from '@/content-moderation/moderation-review.types';
import {
  AreaManifest,
  Probe,
  ReasonedPath,
  RebuildStep,
  TableEntry
} from '@/rebuild/manifest.types';
import { PROBE_CALLER } from '@/rebuild/manifests/probe-fixture';
import {
  STAYING_METRICS_WHERE,
  stayingMetricsPlans,
  stayingWavesPlans
} from '@/rebuild/manifests/waves-staying';
import {
  RELAY_WORLD_WALLET,
  WAVES_WORLD_IDS
} from '@/rebuild/world/waves/world-ids';

/** 6529.io's moderation audit log, split by writer on its action column. */
const MODERATION_AUDIT_TABLE = 'content_moderation_audit_log';

/** The audit rows of a person's own blocks and hides (their records). */
const PERSONAL_AUDIT_ACTIONS = [
  'PROFILE_BLOCKED',
  'PROFILE_UNBLOCKED',
  'DROP_HIDDEN',
  'DROP_UNHIDDEN'
];

/**
 * The audit rows of moderators, the AI evaluator and reports: the drop and
 * profile moderation service's own actions, and the review queue's
 * (MODERATION_ACTIONS).
 */
const SERVICE_AUDIT_ACTIONS = [
  'AI_QUARANTINED',
  'AI_QUARANTINE_WITHDRAWN',
  'CONTENT_REPORTED',
  'CONTENT_REPORT_WITHDRAWN',
  'CONTENT_SAVED',
  'MODERATOR_ALLOWED_OR_RESTORED',
  'MODERATOR_QUARANTINED',
  'MODERATOR_REMOVED',
  'PROFILE_SUSPENDED',
  'PROFILE_REINSTATED',
  ...MODERATION_ACTIONS
];

function auditPartition(actions: readonly string[], reason: string) {
  return {
    table: MODERATION_AUDIT_TABLE,
    partition: {
      columns: ['action'],
      values: actions.map((action) => [action]),
      reason
    }
  };
}

/**
 * The audit log's two writers, both planned: their modules come with later
 * changes, and until then a run keeps each one's rows as seeded and lists
 * them, and a final run fails on them.
 */
const MODERATION_AUDIT_REBUILDERS: RebuildStep[] = [
  {
    id: 'waves.moderation-audit.personal',
    run: {
      module: 'src/rebuild/steps/waves-moderation-audit.steps',
      exportName: 'rebuildPersonalModerationAudit'
    },
    writes: [
      auditPartition(
        PERSONAL_AUDIT_ACTIONS,
        "A person's blocks and hides, rebuilt from their personal records once the personal records' rebuild lands."
      )
    ],
    sources: ['repo'],
    timeoutMinutes: 10,
    origin: 'planned'
  },
  {
    id: 'waves.moderation-audit.service',
    run: {
      module: 'src/content-moderation/moderation-audit.rebuild',
      exportName: 'rebuildModerationAudit'
    },
    writes: [
      auditPartition(
        SERVICE_AUDIT_ACTIONS,
        "Moderators', the AI evaluator's and reports' rows; kept as they are until 2026-12-04, when the moderation service records each decision as a signed record. An AI row's id, time, evaluation and rationale can only come back from such a record."
      )
    ],
    sources: ['repo'],
    timeoutMinutes: 10,
    origin: 'planned'
  }
];

/** The chain index's tables and its state, and its event log. */
export const WAVES_CHAIN_INDEX_TABLES = [
  'chain_waves',
  'chain_groups',
  'chain_wave_roles',
  'chain_polls',
  'chain_wave_rep',
  'chain_decisions',
  'chain_entries',
  'chain_votes',
  'chain_results',
  'chain_decision_leaderboards',
  'chain_leaderboard_rows',
  'chain_events',
  // The index's cursor and full-read state, rebuilt with its rows: kept,
  // it would tell the index the emptied tables are up to date.
  'waves_chain_index_state'
] as const;

/** The chain index read from the gateway (src/rebuild/steps). */
const CHAIN_INDEX_STEPS = 'src/rebuild/steps/waves-chain-index.steps';

/** 6529.io's rows at the freeze for the world's waves. */
const LEGACY_STEPS = 'src/rebuild/steps/waves-legacy.steps';

/** The drop index read from the relays. */
const DROP_INDEX_STEPS = 'src/rebuild/steps/waves-drop-index.steps';
/** The exempt moderation holds: seeded, then checked untouched. */
const HOLDS_STEPS = 'src/rebuild/steps/waves-moderation-holds.steps';
/** The waves' drop metrics, recounted from drops. */
const DROP_METRICS_STEPS = 'src/rebuild/steps/waves-drop-metrics.steps';

/**
 * wave_metrics' columns other than the drop counts: its subscribers' and
 * its scores' (the wave score refresh). Their owners are planned; until
 * they land, a run keeps these columns by key across the rebuild.
 */
const WAVE_SUBSCRIBER_COLUMNS = ['subscribers_count'];
const WAVE_SCORE_COLUMNS = [
  'wave_rep_total',
  'wave_rep_positive',
  'wave_rep_negative',
  'wave_rep_contributor_count',
  'wave_rep_positive_contributor_count',
  'wave_rep_negative_contributor_count',
  'wave_score_version',
  'wave_visibility_tier',
  'wave_visibility_rank',
  'wave_quality_score',
  'wave_hotness_score',
  'wave_rep_sort_score',
  'wave_visibility_score',
  'wave_creator_score',
  'wave_level_weighted_participation_score',
  'wave_trusted_diversity_score',
  'wave_rep_component_score',
  'wave_trusted_subscription_score',
  'wave_recent_trusted_activity_score',
  'wave_single_actor_penalty',
  'wave_low_trust_flood_penalty',
  'wave_cross_post_pressure',
  'wave_cross_post_penalty',
  'wave_negative_rep_penalty',
  'wave_safety_multiplier',
  'wave_score_calculated_at'
];

/**
 * The drop metrics' rebuilder and the planned owners of wave_metrics'
 * other columns. The recount writes wave_metrics' rows (a wave's row
 * appears with its first drop, as in 6529.io) and wave_dropper_metrics
 * whole, after every rebuilder that writes drops.
 */
const DROP_METRICS_REBUILDERS: RebuildStep[] = [
  {
    id: 'waves.drop-metrics',
    run: { module: DROP_METRICS_STEPS, exportName: 'rebuildWavesDropMetrics' },
    writes: ['wave_metrics', 'wave_dropper_metrics'],
    reads: [
      'drops',
      'deleted_drops',
      'waves',
      'competition_entries',
      'competitions'
    ],
    after: ['waves.chain-mirror'],
    sources: ['repo'],
    timeoutMinutes: 15,
    plannedRows: [
      {
        table: 'wave_metrics',
        // A staying wave's row is the staying plan's.
        where: `wave_id not in (select wave_id from drops where wave_id is not null union select wave_id from deleted_drops where wave_id is not null) and not ${STAYING_METRICS_WHERE.wave_metrics}`,
        reason:
          'A wave that never had a drop has a metrics row only through its subscribers or its scores, whose owners are planned.',
        until: '2026-12-04',
        change:
          "The owners of wave_metrics' subscriber and score columns land and write those rows."
      },
      {
        table: 'wave_dropper_metrics',
        where: 'wave_id not in (select id from waves)',
        reason:
          "Left behind when 6529.io deletes a wave: the wave's drops go with no record, so its authors' counts can't be rebuilt.",
        until: '2026-12-04',
        change:
          "6529.io deletes a wave's author metrics with the wave, and the existing ones are removed."
      },
      ...stayingMetricsPlans()
    ]
  },
  {
    id: 'waves.wave-subscriber-count',
    run: {
      module: 'src/rebuild/steps/waves-wave-subscribers.steps',
      exportName: 'rebuildWaveSubscriberCounts'
    },
    writes: [
      {
        table: 'wave_metrics',
        columns: WAVE_SUBSCRIBER_COLUMNS,
        reason: "A wave's subscriber count, from its subscriptions."
      }
    ],
    after: ['waves.drop-metrics'],
    sources: ['repo'],
    timeoutMinutes: 10,
    origin: 'planned'
  },
  {
    id: 'waves.wave-scores',
    run: {
      module: 'src/rebuild/steps/waves-wave-scores.steps',
      exportName: 'rebuildWaveScores'
    },
    writes: [
      {
        table: 'wave_metrics',
        columns: WAVE_SCORE_COLUMNS,
        reason:
          "A wave's REP, score and visibility, from the wave score refresh."
      }
    ],
    after: ['waves.drop-metrics'],
    sources: ['repo'],
    timeoutMinutes: 10,
    origin: 'planned'
  }
];

/**
 * The chain mirror's rebuild (src/waves-chain-mirror): it fills 6529.io's
 * wave, group and competition rows from the chain index, frozen, at the
 * chain's time, with no outbox, claim, follow, notification, activity or
 * socket effects. It reads the chain through the gateway and each document
 * from the capture's files, by CID. Planned until its code is in this
 * tree. It also needs the identity mirror's principal map
 * (identity_chain_principals), which the identity rebuilder writes; that
 * step goes in `after` once both are in one tree.
 */
const MIRROR_STEPS = 'src/waves-chain-mirror/waves-chain-mirror.rebuild';
// The drop tables (drops, drops_parts, drop_medias, drops_metadatas) are
// left out until their writers are settled: the mirror writes the drops of
// entries and descriptions made on the chain, and a reader of the import's
// files writes the drops from before the switch. They come back with that
// split and with the order other areas' readers of drops need.
const MIRROR_WRITES = [
  'waves',
  'waves_metadatas',
  'community_groups',
  'profile_groups',
  'competitions',
  'competition_config_versions',
  'competition_capabilities',
  'competition_outcomes',
  'competition_outcome_distribution_items',
  'competition_lifecycle_events',
  'competition_entries',
  'competition_votes',
  'competition_entry_runtime',
  'competition_leaderboard_entries',
  'competition_decisions',
  'competition_decision_winners',
  'competition_winner_votes',
  'competition_outcome_awards',
  'competition_vote_history',
  'competition_score_history',
  'chain_docs',
  'waves_chain_mirror_state',
  'waves_chain_mirror_events',
  'waves_chain_mirror_groups',
  'waves_chain_mirror_waves',
  'waves_chain_mirror_decisions'
];

/** The drop index's checked relay events, its rejects and its relay cursors. */
export const WAVES_DROP_INDEX_TABLES = [
  'wave_relay_events',
  'wave_relay_rejects',
  'wave_relay_subscriptions'
] as const;

/**
 * What the drop index reads besides its own tables: 6529.io's grants (a
 * revocation it holds) and its signed events (which events 6529.io wrote).
 */
const DROP_INDEX_READS = ['device_grants', 'device_signed_events'];

const PUBLIC_WAVE = WAVES_WORLD_IDS.publicWave;
const RANK_WAVE = WAVES_WORLD_IDS.rankWave;
const MEMBERS_WAVE = WAVES_WORLD_IDS.membersWave;
const WORLD_DROPS = [
  WAVES_WORLD_IDS.firstDrop,
  WAVES_WORLD_IDS.secondDrop,
  // The rank wave's Main Stage winner.
  WAVES_WORLD_IDS.rankWinnerDrop
];

/**
 * Subscription action lists at these paths, compared as sets: the API reads
 * them with no ORDER BY, so their order follows MySQL's plan and can differ
 * between the two passes on the same rows.
 */
function subscribedActions(...prefixes: string[]): ReasonedPath[] {
  return prefixes.map((prefix) => ({
    path: `${prefix}.subscribed_actions`,
    reason:
      'Read with no ORDER BY: the order follows the query plan, not the rows.'
  }));
}

/** A wave's own lists, its author's and its description drop's. */
const waveActions = (at: string) =>
  subscribedActions(
    at,
    `${at}.author`,
    `${at}.description_drop`,
    `${at}.description_drop.author`
  );

/**
 * The main waves routes over the world's waves, anonymous: a wave, the
 * lists, its drops, a rank wave's decisions, leaderboard and competitions,
 * a drop, groups. The members-only wave is asked for too: anonymous, it
 * must stay hidden the same way in both passes.
 */
const PROBES: Probe[] = [
  {
    id: 'waves.wave',
    path: '/api/waves/{wave}',
    each: { wave: [PUBLIC_WAVE, MEMBERS_WAVE, RANK_WAVE] },
    unordered: waveActions('$')
  },
  {
    // Signed in as the waves' author: the wave's metrics then carry the
    // caller's own drop counts (wave_dropper_metrics).
    id: 'waves.wave-as-author',
    path: '/api/waves/{wave}',
    each: { wave: [PUBLIC_WAVE, RANK_WAVE] },
    as: PROBE_CALLER,
    unordered: waveActions('$')
  },
  {
    id: 'waves.wave-v3',
    path: `/api/v3/waves/${PUBLIC_WAVE}`,
    unordered: waveActions('$.configuration')
  },
  {
    id: 'waves.list',
    path: '/api/waves?limit=20',
    unordered: waveActions('$[*]')
  },
  {
    id: 'waves.list-v2',
    path: '/api/v2/waves?page_size=20',
    unordered: subscribedActions('$.data[*].creator')
  },
  {
    id: 'waves.overview',
    path: '/api/waves-overview?type=RECENTLY_DROPPED_TO&limit=20',
    unordered: waveActions('$[*]')
  },
  {
    id: 'waves.drops',
    path: `/api/waves/${PUBLIC_WAVE}/drops?limit=20`,
    unordered: subscribedActions('$.drops[*]', '$.drops[*].author')
  },
  {
    id: 'waves.drops-v2',
    path: `/api/v2/waves/${PUBLIC_WAVE}/drops?limit=20`,
    unordered: subscribedActions('$.wave.creator')
  },
  {
    id: 'waves.drop',
    path: '/api/drops/{drop}',
    each: { drop: WORLD_DROPS },
    unordered: subscribedActions('$', '$.author')
  },
  {
    id: 'waves.drop-v2',
    path: '/api/v2/drops/{drop}',
    each: { drop: WORLD_DROPS },
    unordered: subscribedActions('$.wave.creator')
  },
  {
    id: 'waves.drop-signed-events',
    path: `/api/drops/${WAVES_WORLD_IDS.firstDrop}/signed-events`
  },
  {
    id: 'waves.decisions',
    path: `/api/waves/${RANK_WAVE}/decisions`,
    unordered: subscribedActions(
      '$.data[*].winners[*].drop',
      '$.data[*].winners[*].drop.author'
    )
  },
  { id: 'waves.decisions-v2', path: `/api/v2/waves/${RANK_WAVE}/decisions` },
  { id: 'waves.leaderboard', path: `/api/waves/${RANK_WAVE}/leaderboard` },
  {
    id: 'waves.leaderboard-v2',
    path: `/api/v2/waves/${RANK_WAVE}/leaderboard`
  },
  {
    id: 'waves.competitions-v3',
    path: `/api/v3/waves/${RANK_WAVE}/competitions`
  },
  { id: 'waves.groups', path: '/api/groups' },
  { id: 'waves.og-wave', path: `/api/og-metadata/waves/${PUBLIC_WAVE}` }
];

const CHAIN_INDEX_TABLE_ENTRIES: Record<string, TableEntry> =
  Object.fromEntries(
    WAVES_CHAIN_INDEX_TABLES.map((table) => [table, { class: 'INDEX' }])
  );

/**
 * Waves: waves, drops, reactions, mentions, polls, curations, decisions,
 * votes, wave REP and groups.
 */
export const wavesManifest: AreaManifest = {
  area: 'waves',
  flags: {},
  tables: {
    official_waves: { class: 'INDEX' },
    profile_waves: { class: 'INDEX' },
    waves: { class: 'INDEX' },
    waves_archive: { class: 'INDEX' },
    waves_metadatas: { class: 'INDEX' },
    community_groups: { class: 'INDEX' },
    // Not in this tree's schema yet (main adds it with the group visibility
    // route); planned until this branch takes main. A retry after a fresh
    // start can't apply twice: a replacement's retry finds its group id
    // gone (renamed to the old version's) and fails, and a plain change
    // sets the same visibility again.
    community_group_visibility_requests: {
      class: 'EPHEMERAL',
      why: 'Retry keys for group visibility changes; a fresh start has none in flight.',
      origin: 'planned'
    },
    membership_generation_members: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_group_versions: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_materialization_states: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_publications: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_refresh_requests: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_refresh_runs: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_refresh_targets: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_runtime_checkpoints: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_source_jobs: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_source_states: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    membership_watermarks: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    profile_group_changes: { class: 'INDEX' },
    profile_groups: { class: 'INDEX' },
    user_group_members: {
      class: 'RETIRED',
      why: 'Retired membership storage: no table in a fresh schema.'
    },
    viewer_group_set_members: { class: 'INDEX' },
    viewer_group_sets: { class: 'INDEX' },
    deleted_drops: { class: 'INDEX' },
    device_grants: { class: 'INDEX' },
    device_signed_events: { class: 'INDEX' },
    drop_author_signatures: { class: 'INDEX' },
    drop_client_ids: { class: 'INDEX' },
    drop_medias: { class: 'INDEX' },
    drop_nft_links: { class: 'INDEX' },
    drop_relations: { class: 'INDEX' },
    drops: { class: 'INDEX' },
    drops_metadatas: { class: 'INDEX' },
    drops_parts: { class: 'INDEX' },
    drops_referenced_nfts: { class: 'INDEX' },
    wave_chat_drop_cooldowns: {
      class: 'EPHEMERAL',
      why: 'Posting cooldowns; they expire.'
    },
    drop_boosts: { class: 'INDEX' },
    drop_curations: { class: 'INDEX' },
    drop_mentioned_groups: { class: 'INDEX' },
    drop_mentioned_waves: { class: 'INDEX' },
    drop_poll_options: { class: 'INDEX' },
    drop_poll_votes: { class: 'INDEX' },
    drop_polls: { class: 'INDEX' },
    drop_reactions: { class: 'INDEX' },
    drops_mentions: { class: 'INDEX' },
    wave_curation_groups: { class: 'INDEX' },
    competition_capabilities: { class: 'INDEX' },
    competition_capability_audits: { class: 'INDEX' },
    competition_claims: { class: 'INDEX' },
    competition_commands: { class: 'INDEX' },
    competition_config_versions: { class: 'INDEX' },
    competition_decision_winners: { class: 'INDEX' },
    competition_decisions: { class: 'INDEX' },
    competition_entries: { class: 'INDEX' },
    competition_entry_content_versions: { class: 'INDEX' },
    competition_entry_runtime: { class: 'INDEX' },
    competition_event_effects: { class: 'INDEX' },
    competition_leaderboard_entries: { class: 'INDEX' },
    competition_legacy_execution_effects: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_legacy_mirror_permits: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_lifecycle_events: { class: 'INDEX' },
    competition_migration_audits: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_migration_changes: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_migration_environments: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_migrations: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_outbox: {
      class: 'EPHEMERAL',
      why: 'Outbox of competition events waiting for delivery.'
    },
    competition_outcome_awards: { class: 'INDEX' },
    competition_outcome_distribution_items: { class: 'INDEX' },
    competition_outcomes: { class: 'INDEX' },
    competition_parity_observations: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    competition_pauses: { class: 'INDEX' },
    competition_score_history: { class: 'INDEX' },
    competition_score_reset_state: { class: 'INDEX' },
    competition_score_resets: { class: 'INDEX' },
    competition_signature_nonces: { class: 'INDEX' },
    competition_vote_history: { class: 'INDEX' },
    competition_votes: { class: 'INDEX' },
    competition_winner_votes: { class: 'INDEX' },
    competition_worker_cursors: {
      class: 'EPHEMERAL',
      why: 'Worker cursors.'
    },
    competitions: { class: 'INDEX' },
    dr_vote_backup_20250506: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_ranks: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_real_vote_in_time: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_real_vote_in_time_xxx: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_real_voter_vote_in_time: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_voter_states: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drop_voter_states_backup_20250506: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drops_votes_credit_spendings: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    drv_vote_backup_20250506: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_decision_winner_drops: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_decisions: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_leaderboard_entries: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_outcome_distribution_items: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_outcomes: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_voting_credit_nfts: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    wave_voting_credit_nfts_archive: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    waves_decision_pauses: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    winner_drop_voter_votes: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    winner_drop_voter_votes_bckup_15_07_25_1: {
      class: 'RETIRED',
      why: 'Retired competition storage: no table in a fresh schema; reads go to the legacy_get_* views.'
    },
    attachments: { class: 'INDEX' },
    drop_attachments: { class: 'INDEX' },
    drop_media_uploads: {
      class: 'EPHEMERAL',
      why: 'Media uploads in flight.'
    },
    media_upload_budget_entries: {
      class: 'EPHEMERAL',
      why: 'Upload rate budget counters.'
    },
    activity_events: { class: 'INDEX' },
    wave_drop_metrics_refresh_requests: {
      class: 'EPHEMERAL',
      why: 'Refresh queue.'
    },
    wave_dropper_metrics: { class: 'INDEX' },
    wave_metrics: { class: 'INDEX' },
    wave_reader_metrics: { class: 'INDEX' },
    wave_score_refresh_requests: {
      class: 'EPHEMERAL',
      why: 'Refresh queue.'
    },
    // Split by writer on its action column (MODERATION_AUDIT_REBUILDERS).
    content_moderation_audit_log: { class: 'INDEX' },
    content_moderation_drop_states: { class: 'INDEX' },
    content_moderation_profile_states: { class: 'INDEX' },
    content_moderation_roles: { class: 'INDEX' },
    art_curation_token_watch_drops: { class: 'INDEX' },
    art_curation_token_watches: { class: 'INDEX' },
    // 6529.io's index of the chain's waves and its event log
    // (src/waves-chain-index), rebuilt by waves.chain-index from the gateway.
    ...CHAIN_INDEX_TABLE_ENTRIES,
    chain_claim_builds: {
      class: 'EPHEMERAL',
      why: 'Outbox of Main Stage claim-build messages: a kept row stops a second send. The rebuild queues none.'
    },
    // Relay publishing and the drop index (src/wave-relay-publish,
    // src/wave-drop-index).
    wave_relay_cursors: {
      class: 'EPHEMERAL',
      why: 'Relay publishing cursor: the relays already hold what it passed, and a lost cursor only publishes copies they drop.'
    },
    // received_at is compared: the rebuild stores when the relays first
    // held each event (their receipts), as the seed does, so it must come
    // back the same.
    wave_relay_events: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'next_try_at',
          reason: 'When the applier tries a waiting event again.'
        }
      ]
    },
    wave_relay_rejects: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'received_at',
          reason: 'When 6529.io read the copy; no route shows it.'
        }
      ]
    },
    wave_relay_subscriptions: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'updated_at', reason: 'When the cursor last moved.' }
      ]
    },
    // The settlement sender (src/waves-settlement); planned until its code
    // is in this tree.
    waves_settlement_sends: {
      class: 'EPHEMERAL',
      origin: 'planned',
      why: "The sender's in-flight request per decision step. A lost row costs one repeat request, which the chain refuses: every request for a decision step takes the same nonce."
    },
    // The chain mirror (src/waves-chain-mirror): its own tables, rebuilt
    // with competition_* by the mirror's rebuild once its code is here.
    waves_chain_mirror_state: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_events: { class: 'INDEX', origin: 'planned' },
    chain_docs: { class: 'INDEX', origin: 'planned' },
    // A rebuild must never release a hold (entries', and a chain-made wave's
    // description's, keyed by its description drop id), and a final run
    // fails while these holds have no source outside MySQL. When each hold
    // and release is a signed record keyed by its id (newest wins), the
    // table becomes INDEX with a rebuilder.
    chain_entry_holds: {
      class: 'EXEMPT',
      why: "6529.io's moderation holds on chain entries; kept as they are until the moderation service records each hold and release as a signed record, as content_moderation_items' decisions already are.",
      until: '2026-12-04',
      origin: 'planned'
    },
    waves_chain_mirror_groups: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_waves: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_decisions: { class: 'INDEX', origin: 'planned' }
  },
  seeds: [
    {
      id: 'waves.legacy.seed',
      run: { module: LEGACY_STEPS, exportName: 'seedWavesLegacy' },
      writes: [
        'waves',
        'drops',
        'drops_parts',
        'community_groups',
        'competitions',
        'competition_config_versions',
        'competition_capabilities',
        'competition_decisions',
        'competition_entries',
        'competition_decision_winners',
        'competition_lifecycle_events',
        'wave_metrics',
        'wave_dropper_metrics'
      ],
      // The fixture profiles the waves and drops name.
      after: ['identity.probe-profiles'],
      sources: ['repo'],
      timeoutMinutes: 5
    },
    {
      id: 'waves.chain-index.seed',
      run: { module: CHAIN_INDEX_STEPS, exportName: 'seedWavesChainIndex' },
      writes: [...WAVES_CHAIN_INDEX_TABLES],
      sources: ['gateway'],
      timeoutMinutes: 15
    },
    {
      // The holds, and a refused description on one of the chain index's
      // chain-made waves.
      id: 'waves.moderation-holds.seed',
      run: { module: HOLDS_STEPS, exportName: 'seedWavesModerationHolds' },
      writes: ['chain_entry_holds'],
      reads: ['chain_waves'],
      after: ['waves.chain-index.seed'],
      sources: ['repo'],
      timeoutMinutes: 5
    },
    {
      id: 'waves.drop-index.seed',
      run: { module: DROP_INDEX_STEPS, exportName: 'seedWavesDropIndex' },
      writes: [...WAVES_DROP_INDEX_TABLES],
      reads: DROP_INDEX_READS,
      sources: ['relays'],
      timeoutMinutes: 10
    }
  ],
  rebuilders: [
    {
      id: 'waves.chain-index',
      run: { module: CHAIN_INDEX_STEPS, exportName: 'rebuildWavesChainIndex' },
      writes: [...WAVES_CHAIN_INDEX_TABLES],
      sources: ['gateway'],
      timeoutMinutes: 30
    },
    {
      id: 'waves.drop-index',
      run: { module: DROP_INDEX_STEPS, exportName: 'rebuildWavesDropIndex' },
      writes: [...WAVES_DROP_INDEX_TABLES],
      reads: DROP_INDEX_READS,
      sources: ['relays'],
      timeoutMinutes: 15
    },
    {
      id: 'waves.chain-mirror',
      run: { module: MIRROR_STEPS, exportName: 'rebuildWavesChainMirror' },
      writes: MIRROR_WRITES,
      reads: [
        ...WAVES_CHAIN_INDEX_TABLES,
        // Its moderation holds, which it reads and never writes in a rebuild.
        'chain_entry_holds',
        'identity_chain_principals',
        'identities',
        'profiles',
        'address_consolidation_keys'
      ],
      after: ['waves.chain-index'],
      // The chain through the gateway; the documents from the capture's files.
      sources: ['gateway', 'files'],
      timeoutMinutes: 30,
      origin: 'planned',
      plannedRows: stayingWavesPlans(MIRROR_WRITES)
    },
    {
      // Writes nothing: proves the exempt holds come through every waves
      // rebuilder that could touch them exactly as the seed left them, and,
      // once the mirror runs, that the refused description stays out while
      // a control wave's comes in.
      id: 'waves.moderation-holds.check',
      run: { module: HOLDS_STEPS, exportName: 'checkWavesModerationHolds' },
      writes: [],
      reads: [
        'chain_entry_holds',
        'chain_waves',
        'waves',
        'drops_parts',
        'waves_chain_mirror_state'
      ],
      after: ['waves.chain-index', 'waves.drop-index', 'waves.chain-mirror'],
      sources: ['repo'],
      timeoutMinutes: 5
    },
    ...MODERATION_AUDIT_REBUILDERS,
    ...DROP_METRICS_REBUILDERS
  ],
  probes: PROBES,
  // A replayed relay recording of the world's drops counts per event: the
  // drop index's own check of each one. The prefixes cover the world's
  // waves (made-up 6529.io wave ids) and waves named by their chain id.
  relayChecks: [
    {
      waves: ['00000000-0000-4000-8000-', '0x'],
      run: {
        module: 'src/rebuild/steps/waves-relay-check',
        exportName: 'checkWavesRelayEvent'
      }
    }
  ],
  // As the chain and the relays' operator would have it: the world's public
  // wave is open; its members-only wave is read by 6529.io's site reader,
  // as the drop index reads members-only waves in production.
  relayAccess: {
    openWaves: [WAVES_WORLD_IDS.publicWave],
    readers: [
      {
        wallet: RELAY_WORLD_WALLET,
        roles: ['site-reader'],
        reason:
          "6529.io's site reader (WAVES_DROP_INDEX_READER): the drop index reads members-only waves with it. The test grant's wallet."
      }
    ]
  },
  waivers: {
    unprobedTables: [
      ...WAVES_CHAIN_INDEX_TABLES.map((target) => ({
        target,
        reason:
          'No route reads the chain index yet: the chain mirror and the claims builder do. The run compares its rows table by table.'
      })),
      ...WAVES_DROP_INDEX_TABLES.map((target) => ({
        target,
        reason:
          'No route reads the drop index: the drop applier and the notifications do. The run compares its rows table by table.'
      }))
    ],
    unseededTables: [
      {
        target: 'wave_relay_rejects',
        reason:
          "Copies a relay served that fail the drop index's check. A correct relay serves none: the devnet's relays check every event, and a replayed recording must pass the waves relay check, so the world holds no rejected copy to rebuild."
      }
    ]
  }
};
