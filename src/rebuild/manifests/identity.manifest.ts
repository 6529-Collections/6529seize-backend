import { AreaManifest } from '@/rebuild/manifest.types';

/**
 * Identity: identities, profiles, handles, consolidations, delegations,
 * REP, NIC, levels and proxies.
 */
export const identityManifest: AreaManifest = {
  area: 'identity',
  flags: {},
  tables: {
    // The seed identity.probe-profiles writes the probe fixture's profiles
    // (rebuild-probe-1 for 0x...01, rebuild-probe-2 for 0x...02) here and in
    // address_consolidation_keys. The identity rebuilder must bring them
    // back from its sources, or every probe that signs in answers
    // differently after the drop.
    identities: { class: 'INDEX' },
    profiles: { class: 'INDEX' },
    profiles_archive: { class: 'INDEX' },
    address_consolidation_keys: { class: 'INDEX' },
    consolidations: { class: 'INDEX' },
    delegations: { class: 'INDEX' },
    nftdelegation_blocks: {
      class: 'EPHEMERAL',
      why: 'Loop cursor: the last NFTDelegation block read.'
    },
    cic_score_aggregations: { class: 'INDEX' },
    cic_statements: { class: 'INDEX' },
    events: {
      class: 'EPHEMERAL',
      why: 'Event queue that the listeners drain.'
    },
    listener_processed_events: {
      class: 'EPHEMERAL',
      why: 'Listener cursors: which events each listener has handled.'
    },
    profile_total_rep_score_aggregations: { class: 'INDEX' },
    rating_credit_locks: {
      class: 'EPHEMERAL',
      why: 'Short-lived locks on rating credit.'
    },
    ratings: { class: 'INDEX' },
    rep_rating_removals: {
      class: 'EXEMPT',
      why: "audit and undo record of an operator-run one-off job (#2550); written only when an operator applies it; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    // Pending: the over-rates loop's Arweave rates upload writes it.
    // RatingsSnapshot is missing from src/entities/entities.ts, so a fresh
    // schema has no table; registering it there is a one-line fix.
    ratings_snapshots: { class: 'INDEX' },
    profile_proxies: { class: 'INDEX' },
    profile_proxy_actions: { class: 'INDEX' },
    profile_proxy_rating_credit_balances: { class: 'INDEX' },
    profile_activity_logs: { class: 'INDEX' },
    profile_latest_logs: { class: 'INDEX' },
    help_bot_credit_events: { class: 'INDEX' },
    help_bot_daily_activity_credit_requests: { class: 'INDEX' },
    identity_chain_principals: { class: 'INDEX', origin: 'planned' },
    identity_chain_mirror_state: {
      class: 'EPHEMERAL',
      why: 'Mirror loop cursor.',
      origin: 'planned'
    }
  },
  // A profile for each probe fixture wallet (probe-fixture.ts), for the
  // probes that sign in, written as identity rows. Identity's rebuilder
  // must bring them back from its sources.
  seeds: [
    {
      id: 'identity.probe-profiles',
      run: {
        module: 'src/rebuild/run/probe-fixture.steps',
        exportName: 'seedProbeIdentities'
      },
      writes: ['identities', 'address_consolidation_keys'],
      sources: ['repo'],
      timeoutMinutes: 5
    }
  ],
  rebuilders: [],
  probes: []
};
