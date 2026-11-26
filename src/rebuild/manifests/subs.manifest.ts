import { createHash } from 'node:crypto';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import { WIDE_TOP_UP } from '@/rebuild/areas/subs.wide-identity';
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
  SIGNED_RECORDS_WAVE_ID: '00000000-0000-4000-8000-0000000000e1',
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

/**
 * The signed record heads subscriptions keep: their four choice types in
 * the ps family (src/subscriptions-identity/records/subscription-records.ts),
 * written live through the record index and put back by the rebuild from
 * each choice's journal entry. No `~` heads. Other areas keep their own
 * types' heads, so the table is shared by partition.
 */
const SUBSCRIPTION_HEADS = {
  table: 'signed_record_heads',
  partition: {
    columns: ['family', 'rtype'],
    values: [
      ['ps', 'subs.mode'],
      ['ps', 'subs.all-editions'],
      ['ps', 'subs.card'],
      ['ps', 'subs.count']
    ],
    reason:
      "The subscription choices' signed record heads: the rebuild puts each back from its journal entry, the newest per key"
  }
};

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
 * for the first, and the transactions loop's processed block at the
 * chain's head. In the world's order this comes before any card is
 * minted, so before the holdings seed.
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
    'transactions_processed_subscriptions_blocks',
    // The wide identity (subs.wide-identity.ts), its profile and its
    // wallets' key.
    'identities',
    'profiles',
    'address_consolidation_keys'
  ],
  // The probe wallets' keys.
  after: ['identity.probe-profiles'],
  // Before any card is minted: the redemption loop's block is the chain's
  // head before the holdings seed mints card 1.
  before: ['holdings.seed'],
  sources: ['ethereum', 'repo'],
  timeoutMinutes: 10
};

/** The legacy tables the daily build writes, beside the top-up's. */
const LEGACY_LIST_WRITES = [
  'subscriptions_nfts_final',
  'subscriptions_nfts_final_upload'
];

/**
 * The switch (`go-live`, with the opening files in the seed files), a
 * top-up after it through the identity writer, a signed choice through the
 * write route's writer, the daily build of the next card's list
 * (published into the seed files, the legacy tables written
 * the same rows), a checkpoint, and the journal's closed segment in the
 * records wave (src/rebuild/areas/subs.seed.ts). The cut and the build
 * read the identity mirror. Before the holdings seed, so the list is for
 * card 1, which that seed mints.
 */
const SUBS_SWITCH_SEED: RebuildStep = {
  id: 'subs.switch',
  run: {
    module: 'src/rebuild/areas/subs.seed',
    exportName: 'seedSubscriptionsSwitch'
  },
  writes: [
    ...LEGACY_WRITES,
    ...LEGACY_LIST_WRITES,
    ...IDENTITY_TABLES,
    'subscriptions_id_reports',
    'signed_record_log_entries',
    'signed_record_log_segments',
    // The signed choice's head, in the subscriptions' (ps, subs.*) types.
    'signed_record_heads',
    'identities',
    'address_consolidation_keys',
    // The wide identity's principal, which the cut keys it by.
    'identity_chain_principals',
    'profiles',
    'waves',
    'drops',
    'drops_parts',
    // The records service following its head drops, and the drops'
    // metrics, as drop creation does.
    'identity_subscriptions',
    'wave_metrics',
    'wave_dropper_metrics'
  ],
  reads: [
    'nfts',
    'transactions_processed_subscriptions_blocks',
    'subscriptions_top_up_latest_block',
    'identity_chain_principals'
  ],
  after: ['subs.seed'],
  // The list is card 1's, which the holdings seed mints after it.
  before: ['holdings.seed'],
  sources: ['ethereum', 'files', 'repo'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 15
};

/**
 * After the holdings seed has minted and indexed the cards: the
 * transactions loop's redemption run, the legacy loop then the identity
 * writer, which charges card 1's airdrop to its subscriber; then a
 * checkpoint and the journal's new segment (src/rebuild/areas/subs.seed.ts).
 * It waits on the identity mirror with the switch, whose journal it
 * continues.
 */
const SUBS_REDEMPTIONS_SEED: RebuildStep = {
  id: 'subs.redemptions',
  run: {
    module: 'src/rebuild/areas/subs.seed',
    exportName: 'seedSubscriptionRedemptions'
  },
  writes: [
    ...LEGACY_WRITES,
    'subscriptions_nfts_final',
    'subscriptions_redeemed',
    'transactions_processed_subscriptions_blocks',
    ...IDENTITY_TABLES,
    'subscriptions_id_reports',
    'signed_record_log_entries',
    'signed_record_log_segments',
    'drops',
    'drops_parts',
    // The records service following its head drops, and the drops'
    // metrics, as drop creation does.
    'identity_subscriptions',
    'wave_metrics',
    'wave_dropper_metrics'
  ],
  reads: ['transactions', 'identity_chain_principals'],
  // The holdings seed's mints, indexed into transactions.
  after: ['subs.switch', 'holdings.seed'],
  // The mint stats the mint seed writes count this redemption.
  before: ['mint.probes.seed'],
  sources: ['files'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 10
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
  writes: [...IDENTITY_TABLES, SUBSCRIPTION_HEADS],
  // The records wave: the head drops the records service posted.
  reads: ['drops', 'drops_parts'],
  sources: ['files'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 15
};

/**
 * subscriptions_top_up and the deferred writes queue's top-ups from
 * Ethereum: the top-up loop's own discovery from genesis to the mark, each
 * top-up written where persistTopUps puts it by its own rule (the row, or
 * the whole top-up queued when the key-width guard holds its key back),
 * with no credit and no cursor
 * (src/subscriptionsTopUpLoop/top-ups-rebuild-check.steps.ts).
 */
const SUBS_TOP_UPS_REBUILD: RebuildStep = {
  id: 'subs.top-ups',
  run: {
    module: 'src/subscriptionsTopUpLoop/top-ups-rebuild-check.steps',
    exportName: 'rebuildTopUpsInCheck'
  },
  writes: [
    'subscriptions_top_up',
    {
      table: 'subscription_deferred_writes',
      partition: {
        columns: ['kind'],
        values: [['TOP_UP']],
        reason:
          "The queued top-ups, which persistTopUps' rule rebuilds from Ethereum; the legacy writers' kinds are rebuilt elsewhere"
      }
    }
  ],
  reads: [
    // persistTopUps' rule: the sender's key, the balance a merge moved it
    // to (read FOR UPDATE), and the key-width guard's column widths.
    'address_consolidation_keys',
    'subscriptions_balances',
    'subscriptions_mode',
    'subscriptions_nfts',
    'subscriptions_nfts_final',
    'subscriptions_logs',
    'subscriptions_redeemed'
  ],
  // The rule reads the legacy tables as the copy-back leaves them.
  after: ['subs.legacy-history'],
  sources: ['ethereum'],
  timeoutMinutes: 15
};

/**
 * The whole rollback copy from the rebuilt identity tables, in one step so
 * the key-width guard's rule sees every legacy key column: final rows,
 * list uploads and redemptions (same key, same final-row id, the same
 * published list), then balances, modes and choices under each identity's
 * consolidation key as the dual write uses it, which reads the identity
 * mirror. It leaves out the keys the guard's width rule holds back, and
 * does not read the queue.
 */
const SUBS_LEGACY_HISTORY_REBUILD: RebuildStep = {
  id: 'subs.legacy-history',
  run: {
    module: 'src/subscriptions-identity/opening/rebuild-check.steps',
    exportName: 'rebuildLegacyHistoryInCheck'
  },
  writes: [
    'subscriptions_nfts_final',
    'subscriptions_nfts_final_upload',
    'subscriptions_redeemed',
    'subscriptions_balances',
    'subscriptions_mode',
    'subscriptions_nfts'
  ],
  reads: [
    'subscriptions_id_nfts_final',
    'subscriptions_id_nfts_final_upload',
    'subscriptions_id_redeemed',
    'subscriptions_id_balances',
    'subscriptions_id_mode',
    'subscriptions_id_nfts',
    // The identities' consolidation keys (consolidationKeysOf).
    'identity_chain_principals',
    'identities',
    'address_consolidation_keys',
    // The sixth key column the guard's width rule measures.
    'subscriptions_logs'
  ],
  after: ['subs.identity'],
  sources: ['repo'],
  needs: NEEDS_IDENTITY_MIRROR,
  timeoutMinutes: 10
};

/** The card the seeds build a list for and charge the airdrop of. */
const CARD_WITH_LIST = PROBE_MEME_IDS[0];

/** The subscription answers, for the probe fixture's consolidations. */
const PROBES: Probe[] = [
  {
    id: 'subs.details',
    path: '/api/subscriptions/consolidation/details/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    // The wide identity, by one of its wallets: the balance its queued
    // top-up got at the cut, which the rebuild must give back.
    id: 'subs.details-wide',
    path: `/api/subscriptions/consolidation/details/${WIDE_TOP_UP.wallet}`
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
    // Only the first wallet has log lines (its automatic mode and all
    // editions); the second wallet's top-ups write none.
    each: { key: [PROBE_CONSOLIDATION_KEYS[0]] }
  },
  {
    id: 'subs.redeemed',
    path: '/api/subscriptions/consolidation/redeemed/{key}',
    // Only the first wallet is on card 1's list, whose airdrop is charged.
    each: { key: [PROBE_CONSOLIDATION_KEYS[0]] }
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
    id: 'subs.final',
    path: `/api/subscriptions/consolidation/final/{key}/${PROBE_MEMES_CONTRACT}/{id}`,
    // Card 1's list holds only the first wallet; card 2 has no list.
    each: { key: [PROBE_CONSOLIDATION_KEYS[0]], id: [CARD_WITH_LIST] }
  },
  {
    id: 'subs.final-phase',
    // The allowlist phase subs.switch pulls card 1's subscriptions into.
    path: `/api/subscriptions/final/${PROBE_MEMES_CONTRACT}/{id}/phases/${encodeURIComponent('Phase 0')}`,
    each: { id: [CARD_WITH_LIST] }
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
    subscriptions_nfts_final_upload: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: "The row's own write time on each side; no route shows it."
        }
      ]
    },
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
    // The key-width guard's queue of held-back writes. After the switch the
    // identity top-up writer reads its pending top-ups, so it is rebuilt,
    // not exempt. subs.top-ups rebuilds its TOP_UP rows. Not rebuilt, and
    // so failing a final run, until the legacy tables and this queue are
    // dropped after the rollback window:
    // - the other kinds' rows (FINAL_ROW, LOG, AUTO_SUBSCRIPTION,
    //   REDEMPTION): production makes them only for a key that still has
    //   legacy rows and that the guard holds back (too long for a legacy
    //   column, or with a write waiting), from those legacy rows, which the
    //   identity tables don't keep; a wide identity has none;
    // - CONSOLIDATION rows queued after the switch: their regroups are the
    //   identity mirror's, which neither the journal nor the identity
    //   tables keep;
    // - replayed rows: a replay runs only once the key fits, so the
    //   rebuild gives that top-up its row and queues nothing; the whole
    //   replayed queue row is missing.
    // And in the legacy tables (subs.legacy-history applies the guard's
    // width rule only): a key that fits but has an earlier write still
    // waiting gets its rows copied where production holds them until the
    // replay; a key over 567 characters with legacy rows from before the
    // guard keeps them in production, and the copy leaves them out.
    subscription_deferred_writes: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'sequence',
          reason:
            'Each side numbers its own queue rows; a replay uses the order only within a key, and no route shows it.'
        },
        {
          column: 'created_at',
          reason:
            "When the row was queued: each side's own write time; no route shows it."
        }
      ]
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
  seeds: [SUBS_SEED, SUBS_SWITCH_SEED, SUBS_REDEMPTIONS_SEED],
  rebuilders: [SUBS_REBUILD, SUBS_TOP_UPS_REBUILD, SUBS_LEGACY_HISTORY_REBUILD],
  probes: PROBES,
  waivers: {
    routes: [
      {
        target:
          'GET /api/subscriptions/consolidation/{consolidation_key}/airdrop-address',
        reason:
          "No probe wallet delegates its airdrops, so the answer only repeats the wallet asked about: it can't hold data in the probe world."
      },
      {
        target: 'GET /api/subscriptions/redeemed-memes-counts',
        reason:
          "It lists cards from 220 on, where subscriptions began; the probe world's cards are 1 to 3, and 4 is upcoming, so it can't hold data there."
      }
    ]
  }
};
