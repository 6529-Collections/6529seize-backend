import { AreaManifest, Probe, TableEntry } from '@/rebuild/manifest.types';
import { WAVES_WORLD_IDS } from '@/rebuild/world/waves/world-ids';

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

const PUBLIC_WAVE = WAVES_WORLD_IDS.publicWave;
const RANK_WAVE = WAVES_WORLD_IDS.rankWave;
const MEMBERS_WAVE = WAVES_WORLD_IDS.membersWave;
const WORLD_DROPS = [WAVES_WORLD_IDS.firstDrop, WAVES_WORLD_IDS.secondDrop];

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
    each: { wave: [PUBLIC_WAVE, MEMBERS_WAVE, RANK_WAVE] }
  },
  { id: 'waves.wave-v3', path: `/api/v3/waves/${PUBLIC_WAVE}` },
  { id: 'waves.list', path: '/api/waves?limit=20' },
  { id: 'waves.list-v2', path: '/api/v2/waves?page_size=20' },
  {
    id: 'waves.overview',
    path: '/api/waves-overview?type=RECENTLY_DROPPED_TO&limit=20'
  },
  { id: 'waves.drops', path: `/api/waves/${PUBLIC_WAVE}/drops?limit=20` },
  { id: 'waves.drops-v2', path: `/api/v2/waves/${PUBLIC_WAVE}/drops?limit=20` },
  { id: 'waves.drop', path: '/api/drops/{drop}', each: { drop: WORLD_DROPS } },
  {
    id: 'waves.drop-v2',
    path: '/api/v2/drops/{drop}',
    each: { drop: WORLD_DROPS }
  },
  {
    id: 'waves.drop-signed-events',
    path: `/api/drops/${WAVES_WORLD_IDS.firstDrop}/signed-events`
  },
  { id: 'waves.decisions', path: `/api/waves/${RANK_WAVE}/decisions` },
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
    content_moderation_audit_log: { class: 'INDEX' },
    content_moderation_drop_states: { class: 'INDEX' },
    content_moderation_profile_states: { class: 'INDEX' },
    content_moderation_roles: { class: 'INDEX' },
    art_curation_token_watch_drops: { class: 'INDEX' },
    art_curation_token_watches: { class: 'INDEX' },
    // The chain index: 6529.io's index of the chain's waves and its event log
    // (src/waves-chain-index), rebuilt by waves.chain-index from the gateway.
    ...CHAIN_INDEX_TABLE_ENTRIES,
    chain_claim_builds: {
      class: 'EPHEMERAL',
      why: 'Outbox of Main Stage claim-build messages: a kept row stops a second send. The rebuild queues none.'
    },
    // Relay publishing and the drop index (src/wave-relay-publish,
    // src/wave-drop-index); planned until their code is in this tree.
    wave_relay_cursors: {
      class: 'EPHEMERAL',
      origin: 'planned',
      why: 'Relay publishing cursor: the relays already hold what it passed, and a lost cursor only publishes copies they drop.'
    },
    wave_relay_events: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        {
          column: 'received_at',
          reason: 'When 6529.io read the event; no route shows it.'
        },
        {
          column: 'next_try_at',
          reason: 'When the applier tries a waiting event again.'
        }
      ]
    },
    wave_relay_rejects: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        {
          column: 'received_at',
          reason: 'When 6529.io read the copy; no route shows it.'
        }
      ]
    },
    wave_relay_subscriptions: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        { column: 'updated_at', reason: 'When the cursor last moved.' }
      ]
    },
    // The settlement sender (src/waves-settlement); planned until
    // its code is in this tree.
    waves_settlement_sends: {
      class: 'EPHEMERAL',
      origin: 'planned',
      why: "The sender's in-flight request per decision step. A lost row costs one repeat request, which the decision's nonce lane makes a no-op."
    },
    // The chain mirror (src/waves-chain-mirror): its own tables, rebuilt
    // with competition_* by waves.chain-mirror once that branch is final.
    waves_chain_mirror_state: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_events: { class: 'INDEX', origin: 'planned' },
    chain_docs: { class: 'INDEX', origin: 'planned' },
    chain_entry_holds: { class: 'INDEX', origin: 'planned' }
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
        'competition_config_versions'
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
    }
  ],
  rebuilders: [
    {
      id: 'waves.chain-index',
      run: { module: CHAIN_INDEX_STEPS, exportName: 'rebuildWavesChainIndex' },
      writes: [...WAVES_CHAIN_INDEX_TABLES],
      sources: ['gateway'],
      timeoutMinutes: 30
    }
  ],
  probes: PROBES,
  waivers: {
    unprobedTables: WAVES_CHAIN_INDEX_TABLES.map((target) => ({
      target,
      reason:
        'No route reads the chain index yet: the chain mirror and the claims builder do. The run compares its rows table by table.'
    }))
  }
};
