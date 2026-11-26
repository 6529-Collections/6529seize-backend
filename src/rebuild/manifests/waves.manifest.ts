import { AreaManifest, TableEntry } from '@/rebuild/manifest.types';

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
    // Materialized answers from the chain API and its change feed.
    chain_waves: { class: 'INDEX' },
    chain_groups: { class: 'INDEX' },
    chain_wave_roles: { class: 'INDEX' },
    chain_decisions: { class: 'INDEX' },
    chain_entries: { class: 'INDEX' },
    chain_votes: { class: 'INDEX' },
    chain_results: { class: 'INDEX' },
    chain_polls: { class: 'INDEX' },
    chain_wave_rep: { class: 'INDEX' },
    chain_decision_leaderboards: { class: 'INDEX' },
    chain_leaderboard_rows: { class: 'INDEX' },
    // Its cursors and completion marker must be rebuilt with the indexed rows.
    waves_chain_index_state: { class: 'INDEX' },
    wave_relay_cursors: {
      class: 'EPHEMERAL',
      why: 'Per-relay publication cursors and delivery retry diagnostics.'
    },
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
    content_moderation_audit_log: { class: 'INDEX' },
    content_moderation_drop_states: { class: 'INDEX' },
    content_moderation_profile_states: { class: 'INDEX' },
    content_moderation_roles: { class: 'INDEX' },
    art_curation_token_watch_drops: { class: 'INDEX' },
    art_curation_token_watches: { class: 'INDEX' },
    // 6529.io's index of the chain's waves and its event log
    // (src/waves-chain-index), rebuilt from the gateway; its rebuilder
    // comes later.
    ...CHAIN_INDEX_TABLE_ENTRIES,
    // The event log is planned until its code is in this tree.
    chain_events: { class: 'INDEX', origin: 'planned' },
    chain_claim_builds: {
      class: 'EPHEMERAL',
      origin: 'planned',
      why: 'Outbox of Main Stage claim-build messages: a kept row stops a second send. The rebuild queues none.'
    },
    // Relay publishing and the drop index (src/wave-relay-publish,
    // src/wave-drop-index); the drop index's tables are planned until its
    // code is in this tree.
    wave_relay_cursors: {
      class: 'EPHEMERAL',
      why: 'Relay publishing cursor: the relays already hold what it passed, and a lost cursor only publishes copies they drop.'
    },
    // received_at is compared: the rebuild stores when the relays first
    // held each event (their receipts), as the seed does, so it must come
    // back the same.
    wave_relay_events: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
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
      origin: 'planned'
    },
    waves_chain_mirror_groups: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_waves: { class: 'INDEX', origin: 'planned' },
    waves_chain_mirror_decisions: { class: 'INDEX', origin: 'planned' }
  },
  seeds: [],
  rebuilders: [],
  probes: []
};
