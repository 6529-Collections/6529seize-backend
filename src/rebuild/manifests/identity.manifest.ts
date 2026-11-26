import { AreaManifest } from '@/rebuild/manifest.types';

const MIRROR_CLOCK =
  "The mirror's clock when it wrote the row; the API never shows it.";

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
    },
    // Empty unless an identity made on the chain waits for its founding
    // wallet's history; the world's history is whole, so it has none.
    identity_chain_founder_waits: {
      class: 'INDEX',
      volatileColumns: [{ column: 'since', reason: MIRROR_CLOCK }]
    },
    identity_chain_wallets: {
      class: 'INDEX',
      volatileColumns: [{ column: 'updated_at', reason: MIRROR_CLOCK }]
    },
    // 6529.io's placeholder profiles, which the mirror lists from `profiles`
    // before its first write. After a drop there are none to list, so the
    // rebuilder lists them from the "placeholders at freeze" file, which
    // holds the set the mirror's first run lists, then restores the ones no
    // chain identity took (placeholder-restore.ts; the world's fixture,
    // which its seed puts into the run's files, until the freeze writes the
    // real file).
    identity_chain_placeholders: { class: 'INDEX' },
    identity_chain_first_bindings: { class: 'INDEX' },
    // A work queue: the wallets whose key the mirror changed, queued in its
    // own transaction for the delegations loop, which re-keys them and takes
    // them off. Written with the keys, so a rebuild from empty queues every
    // wallet of every consolidation; the seed and the rebuilder take them
    // off at their end as the loop does (without the re-keying, which
    // rewrites other areas' tables). Not EPHEMERAL: the mirror writes it in
    // the same transaction as the keys, and a rebuilder writes only INDEX
    // tables.
    identity_chain_regroups: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'queued_at', reason: MIRROR_CLOCK },
        {
          column: 'started_at',
          reason:
            "The clock when a re-keying batch took the wallets up (regroupsStarted): the delegations loop's, or the seed's and the rebuilder's own when they take the queue off at their end."
        }
      ]
    },
    identity_chain_rating_ledger: { class: 'INDEX' },
    identity_chain_rating_categories: { class: 'INDEX' },
    identity_chain_rating_events: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'id',
          reason:
            'Auto-increment; rows match by height, rater, target, matter and category, which are unique.'
        },
        { column: 'created_at', reason: MIRROR_CLOCK }
      ]
    },
    // NFTDelegation's logs after the freeze, recorded and applied to
    // nothing by the delegations loop: Ethereum's, not the mirror's
    // (identity.nftdelegation-logs-after-freeze, planned).
    nftdelegation_logs_after_freeze: { class: 'INDEX' },
    chain_pending_operations: {
      class: 'EPHEMERAL',
      why: "Identity joins signed by the identity's wallet, held until the joining wallet signs, then relayed: not on the chain until relayed, and they expire within a day."
    },
    chain_pending_operation_signers: {
      class: 'EPHEMERAL',
      why: 'The signatures a held identity join waits for (chain_pending_operations).'
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
