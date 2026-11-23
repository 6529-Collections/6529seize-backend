import { AreaManifest, Probe } from '@/rebuild/manifest.types';
import {
  PROBE_CONSOLIDATION_KEYS,
  PROBE_MEME_IDS,
  PROBE_MEMES_CONTRACT,
  PROBE_UPCOMING_MEME_ID
} from '@/rebuild/manifests/probe-fixture';

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
    each: { key: PROBE_CONSOLIDATION_KEYS }
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
  // Replays queued long-key writes once they fit (the subs area's flag).
  flags: { FEATURE_SUBSCRIPTION_DEFERRED_REPLAY: 'true' },
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
    subscriptions_balances: { class: 'INDEX' },
    subscriptions_logs: { class: 'INDEX' },
    subscriptions_mode: { class: 'INDEX' },
    subscriptions_nfts: { class: 'INDEX' },
    subscriptions_nfts_final: { class: 'INDEX' },
    subscriptions_nfts_final_upload: { class: 'INDEX' },
    subscriptions_redeemed: { class: 'INDEX' },
    subscriptions_top_up: { class: 'INDEX' },
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
    subscriptions_id_state: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_top_up: { class: 'INDEX', origin: 'planned' },
    subscriptions_id_cursors: {
      class: 'EPHEMERAL',
      why: "Redemption cursor; restarts from the opening's redemption block.",
      origin: 'planned'
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
  seeds: [],
  rebuilders: [],
  probes: PROBES
};
