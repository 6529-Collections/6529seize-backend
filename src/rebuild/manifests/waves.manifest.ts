import { AreaManifest } from '@/rebuild/manifest.types';

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
    art_curation_token_watches: { class: 'INDEX' }
  },
  seeds: [],
  rebuilders: [],
  probes: []
};
