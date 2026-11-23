import { createHash } from 'node:crypto';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import {
  PROBE_CONSOLIDATION_KEYS,
  PROBE_MEME_IDS,
  PROBE_MEMES_CONTRACT,
  PROBE_UPCOMING_MEME_ID
} from '@/rebuild/manifests/probe-fixture';

/**
 * The records service identity of a rebuild run: a fake wave, profile and
 * wallet, and a provider key made only for the rebuild check, derived from
 * a public label so it can never be mistaken for a real one. The same
 * values in every area that writes the shared record log.
 */
const FIXTURE_PROVIDER_KEY = `0x${createHash('sha256')
  .update('6529 rebuild check: fixture provider key, never a real one')
  .digest('hex')}`;
const FIXTURE_RECORDS_FLAGS = {
  SIGNED_RECORDS_PROVIDER_KEYS: JSON.stringify([
    { id: 'rebuild-fixture', private_key: FIXTURE_PROVIDER_KEY }
  ]),
  SIGNED_RECORDS_WAVE_ID: '00000000-0000-4000-8000-0000000000a1',
  SIGNED_RECORDS_SERVICE_PROFILE_ID: 'rebuild-records-service',
  SIGNED_RECORDS_SERVICE_WALLET: '0x00000000000000000000000000000000000000a1'
};

/**
 * The identity mirror's principals table, which the identity mirror branch
 * (#2516) creates: the opening cut, the identity writers and the dual
 * write's keys read it. Steps that need it wait while it isn't there.
 */
const NEEDS_IDENTITY_MIRROR = [
  {
    table: 'identity_chain_principals',
    reason:
      'The opening cut, the identity writers and the dual write read the identity mirror table, which the identity mirror branch (#2516) creates'
  }
];

/** The identity tables the rebuild fills from the opening files and the journal. */
const IDENTITY_TABLES = [
  'subscriptions_id_balances',
  'subscriptions_id_key_map',
  'subscriptions_id_logs',
  'subscriptions_id_mode',
  'subscriptions_id_nfts',
  'subscriptions_id_nfts_final',
  'subscriptions_id_nfts_final_upload',
  'subscriptions_id_redeemed',
  'subscriptions_id_top_up',
  'subscriptions_id_state',
  'subscriptions_id_cursors'
];

/** The legacy tables the top-up loop's and the settings' writes touch. */
const LEGACY_WRITES = [
  'subscriptions_balances',
  'subscriptions_logs',
  'subscriptions_mode',
  'subscriptions_nfts',
  'subscriptions_top_up',
  'subscription_cache_invalidations',
  'subscription_coverage_refresh_requests',
  'subscription_deferred_writes'
];

/**
 * Today's subscriptions of the probe wallets through the legacy write
 * paths (src/rebuild/areas/subs.seed.ts): a top-up each and all editions
 * for the first, after the transactions loop's first run.
 */
const SUBS_SEED: RebuildStep = {
  id: 'subs.seed',
  run: {
    module: 'src/rebuild/areas/subs.seed',
    exportName: 'seedSubscriptions'
  },
  writes: [
    ...LEGACY_WRITES,
    'subscriptions_top_up_latest_block',
    'transactions_processed_subscriptions_blocks'
  ],
  reads: ['transactions'],
  // The holdings seed's chain and memes, and the probe wallets' keys.
  after: ['holdings.seed', 'identity.probe-profiles'],
  sources: ['ethereum', 'repo'],
  timeoutMinutes: 10
};

/**
 * The switch (`go-live`, with the opening files in the seed files), a
 * top-up after it through the identity writer, a checkpoint, and the
 * journal's closed segment in the records wave
 * (src/rebuild/areas/subs.seed.ts). The cut reads the identity mirror.
 */
const SUBS_SWITCH_SEED: RebuildStep = {
  id: 'subs.switch',
  run: {
    module: 'src/rebuild/areas/subs.seed',
    exportName: 'seedSubscriptionsSwitch'
  },
  writes: [
    ...LEGACY_WRITES,
    ...IDENTITY_TABLES,
    'subscriptions_id_reports',
    'signed_record_log_entries',
    'signed_record_log_segments',
    'identities',
    'address_consolidation_keys',
    'profiles',
    'waves',
    'drops',
    'drops_parts'
  ],
  reads: [
    'nfts',
    'transactions_processed_subscriptions_blocks',
    'subscriptions_top_up_latest_block',
    'identity_chain_principals'
  ],
  after: ['subs.seed'],
  sources: ['ethereum', 'files', 'repo'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 15
};

/**
 * The identity tables from empty: the production rebuild from the opening
 * files and the journal, read from the records wave's head drops and the
 * segment files, then the switch the journal records
 * (src/subscriptions-identity/opening/rebuild-check.steps.ts).
 */
const SUBS_REBUILD: RebuildStep = {
  id: 'subs.identity',
  run: {
    module: 'src/subscriptions-identity/opening/rebuild-check.steps',
    exportName: 'rebuildSubscriptionsInCheck'
  },
  writes: IDENTITY_TABLES,
  // The records wave: the head drops the records service posted.
  reads: ['drops', 'drops_parts'],
  sources: ['files'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 15
};

/**
 * subscriptions_top_up from Ethereum: the top-up loop's own discovery from
 * genesis to the mark, writing the rows alone (no credit, no cursor)
 * (src/subscriptionsTopUpLoop/top-ups-rebuild-check.steps.ts).
 */
const SUBS_TOP_UPS_REBUILD: RebuildStep = {
  id: 'subs.top-ups',
  run: {
    module: 'src/subscriptionsTopUpLoop/top-ups-rebuild-check.steps',
    exportName: 'rebuildTopUpsInCheck'
  },
  writes: ['subscriptions_top_up'],
  // A top-up whose write waits there has no row, as in the loop.
  reads: ['subscription_deferred_writes'],
  sources: ['ethereum'],
  timeoutMinutes: 15
};

/**
 * The rollback copy's final rows and redemptions, copied back from the
 * rebuilt identity tables: same key, same final-row id.
 */
const SUBS_LEGACY_HISTORY_REBUILD: RebuildStep = {
  id: 'subs.legacy-history',
  run: {
    module: 'src/subscriptions-identity/opening/rebuild-check.steps',
    exportName: 'rebuildLegacyHistoryInCheck'
  },
  writes: ['subscriptions_nfts_final', 'subscriptions_redeemed'],
  reads: [
    'subscriptions_id_nfts_final',
    'subscriptions_id_redeemed',
    // The keys the key-width guard holds back are left out.
    'subscription_deferred_writes'
  ],
  after: ['subs.identity'],
  sources: ['repo'],
  needs: [
    {
      table: 'identity_chain_principals',
      reason:
        'It copies the identity tables subs.identity rebuilds, which waits for the identity mirror table (#2516)'
    }
  ],
  timeoutMinutes: 10
};

/**
 * The rollback copy's balances, modes and choices, under each identity's
 * consolidation key as the dual write uses it, which reads the identity
 * mirror.
 */
const SUBS_LEGACY_STATE_REBUILD: RebuildStep = {
  id: 'subs.legacy-state',
  run: {
    module: 'src/subscriptions-identity/opening/rebuild-check.steps',
    exportName: 'rebuildLegacyStateInCheck'
  },
  writes: [
    'subscriptions_balances',
    'subscriptions_mode',
    'subscriptions_nfts'
  ],
  reads: [
    'subscriptions_id_balances',
    'subscriptions_id_mode',
    'subscriptions_id_nfts',
    // The identities' consolidation keys (consolidationKeysOf).
    'identity_chain_principals',
    'identities',
    'address_consolidation_keys',
    // The keys the key-width guard holds back are left out.
    'subscription_deferred_writes'
  ],
  after: ['subs.identity'],
  sources: ['repo'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 10
};

/** The subscription answers, for the probe fixture's consolidations. */
const PROBES: Probe[] = [
  {
    id: 'subs.details',
    path: '/api/subscriptions/consolidation/details/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.top-up',
    path: '/api/subscriptions/consolidation/top-up/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: [
      {
        path: '$.data[*].created_at',
        reason:
          "When discovery wrote the row. Ethereum doesn't carry it, so a rebuild's discovery writes its own time."
      }
    ]
  },
  {
    id: 'subs.logs',
    path: '/api/subscriptions/consolidation/logs/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.redeemed',
    path: '/api/subscriptions/consolidation/redeemed/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.upcoming',
    path: '/api/subscriptions/consolidation/upcoming-memes/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.upcoming-meme',
    // A card that hasn't dropped: the route answers 400 for a dropped one.
    path: `/api/subscriptions/consolidation/upcoming-memes/${PROBE_UPCOMING_MEME_ID}/{key}`,
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.airdrop-address',
    path: '/api/subscriptions/consolidation/{key}/airdrop-address',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'subs.final',
    path: `/api/subscriptions/consolidation/final/{key}/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { key: PROBE_CONSOLIDATION_KEYS, id: PROBE_MEME_IDS }
  },
  {
    id: 'subs.final-phase',
    path: `/api/subscriptions/final/${PROBE_MEMES_CONTRACT}/{id}/phases/Subscriptions`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'subs.meme-count',
    path: '/api/subscriptions/memes/{id}/count',
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'subs.upcoming-counts',
    path: '/api/subscriptions/upcoming-memes-counts'
  },
  {
    id: 'subs.redeemed-counts',
    path: '/api/subscriptions/redeemed-memes-counts?page_size=20'
  },
  {
    id: 'subs.uploads',
    path: `/api/subscriptions/uploads?contract=${PROBE_MEMES_CONTRACT}`
  }
];

/**
 * Meme subscriptions.
 */
export const subsManifest: AreaManifest = {
  area: 'subs',
  flags: {
    // Replays queued long-key writes once they fit (the subs area's flag).
    FEATURE_SUBSCRIPTION_DEFERRED_REPLAY: 'true',
    // The shared record log's records service, which the journal posts through.
    ...FIXTURE_RECORDS_FLAGS
  },
  tables: {
    subscription_cache_invalidations: {
      class: 'EPHEMERAL',
      why: 'Cache invalidation queue.'
    },
    subscription_coverage_alert_states: {
      class: 'EPHEMERAL',
      why: 'Alert de-duplication state.'
    },
    subscription_coverage_refresh_requests: {
      class: 'EPHEMERAL',
      why: 'Refresh queue.'
    },
    // The legacy tables: after the switch, the rollback copy every identity
    // write is also written to. Routes that don't switch still read them, so
    // the copy-back rebuilds them from the identity tables (legacy-copy.ts),
    // and the top-up rows come from Ethereum.
    subscriptions_balances: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        },
        {
          column: 'updated_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
    subscriptions_logs: {
      class: 'EXEMPT',
      why: 'Rollback copy and dual-write check; dropped after the rollback window. No route reads it once the identity tables are the truth.'
    },
    subscriptions_mode: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        },
        {
          column: 'updated_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
    subscriptions_nfts: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'id',
          reason: 'Each side numbers its own choice rows; no route shows it.'
        },
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        },
        {
          column: 'updated_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
    subscriptions_nfts_final: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        },
        {
          column: 'updated_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
    subscriptions_nfts_final_upload: { class: 'INDEX' },
    subscriptions_redeemed: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
    subscriptions_top_up: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason:
            "When discovery wrote the row. Ethereum doesn't carry it, so a rebuild's discovery writes its own time; the top-up probe leaves it out too."
        }
      ]
    },
    subscriptions_top_up_latest_block: {
      class: 'EPHEMERAL',
      why: 'Loop cursor.'
    },
    transactions_processed_subscriptions_blocks: {
      class: 'EPHEMERAL',
      why: 'Loop cursor.'
    },
    // Writes queued because their consolidation key is too long for a key
    // column. Since the rework the API refuses such a change instead of
    // queuing it, so every entry comes back from Ethereum, the daily build
    // or the membership tables.
    subscription_deferred_writes: {
      class: 'INDEX',
      origin: 'planned'
    },
    // The identity-keyed tables: `subscriptions:opening -- load` from the
    // opening and history files, then the identity writers.
    subscriptions_id_balances: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_key_map: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_logs: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_mode: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_nfts: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_nfts_final: {
      class: 'INDEX',
      origin: 'planned'
    },
    subscriptions_id_nfts_final_upload: {
      class: 'INDEX',
      origin: 'planned'
    },
    subscriptions_id_redeemed: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_state: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        {
          column: 'loaded_at',
          reason:
            "When the opening was loaded: the load's own time, not shown by any route."
        },
        {
          column: 'verified_at',
          reason:
            "When the load was verified: the check's own time, not shown by any route."
        }
      ]
    },
    subscriptions_id_top_up: { class: 'INDEX', origin: 'planned' },
    // The redemption cursor and the journal's counter, from the opening and
    // the journal. Go-live's pause marker is gone by the end of each step.
    subscriptions_id_cursors: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        {
          column: 'updated_at',
          reason:
            'When the row was last written: housekeeping, not shown by any route.'
        }
      ]
    },
    subscription_rekey_fallback_state: {
      class: 'EPHEMERAL',
      why: "The re-key fallback's run state; without it the next run starts over.",
      origin: 'planned'
    },
    subscriptions_id_reports: {
      class: 'EPHEMERAL',
      why: 'Comparison evidence; running the comparisons again writes it.',
      origin: 'planned'
    }
  },
  seeds: [SUBS_SEED, SUBS_SWITCH_SEED],
  rebuilders: [
    SUBS_REBUILD,
    SUBS_TOP_UPS_REBUILD,
    SUBS_LEGACY_HISTORY_REBUILD,
    SUBS_LEGACY_STATE_REBUILD
  ],
  probes: PROBES
};
