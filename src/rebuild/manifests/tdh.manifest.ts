import { AreaManifest, Probe } from '@/rebuild/manifest.types';
import {
  PROBE_CALLER,
  PROBE_CONSOLIDATION_KEYS,
  PROBE_MEME_IDS,
  PROBE_MEMES_CONTRACT,
  PROBE_WALLETS
} from '@/rebuild/manifests/probe-fixture';

/** The answers the TDH tables feed, for the probe fixture's wallets. */
const PROBES: Probe[] = [
  { id: 'tdh.blocks', path: '/api/blocks?page_size=20' },
  {
    id: 'tdh.consolidation',
    path: '/api/tdh/consolidation/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'tdh.wallet',
    path: '/api/tdh/wallet/{wallet}',
    each: { wallet: PROBE_WALLETS }
  },
  {
    id: 'tdh.nft',
    path: `/api/tdh/nft/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'tdh.consolidated-metrics',
    path: '/api/tdh/consolidated_metrics?page_size=20'
  },
  { id: 'tdh.rules', path: '/api/tdh/rules', as: PROBE_CALLER },
  {
    id: 'tdh.editions.wallet',
    path: '/api/tdh-editions/wallet/{wallet}',
    each: { wallet: PROBE_WALLETS }
  },
  {
    id: 'tdh.editions.consolidation',
    path: '/api/tdh-editions/consolidation/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  { id: 'tdh.global-history', path: '/api/tdh_global_history?page_size=20' },
  {
    id: 'tdh.recent-history',
    path: '/api/recent_tdh_history/{wallet}',
    each: { wallet: PROBE_WALLETS }
  },
  { id: 'tdh.uploads', path: '/api/uploads?page_size=20' },
  {
    id: 'tdh.consolidated-uploads',
    path: '/api/consolidated_uploads?page_size=20'
  },
  { id: 'tdh.nextgen', path: '/api/nextgen/tdh' },
  { id: 'tdh.oracle.total', path: '/oracle/tdh/total' },
  { id: 'tdh.oracle.percentile', path: '/oracle/tdh/percentile/5000' },
  { id: 'tdh.oracle.cutoff', path: '/oracle/tdh/cutoff/10' },
  {
    id: 'tdh.oracle.nft',
    path: `/oracle/nfts/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'tdh.oracle.address',
    path: '/oracle/address/{wallet}',
    each: { wallet: PROBE_WALLETS }
  },
  { id: 'tdh.xtdh.stats', path: '/api/xtdh/stats' },
  {
    id: 'tdh.xtdh.stats-identity',
    path: '/api/xtdh/stats/{wallet}',
    each: { wallet: PROBE_WALLETS }
  },
  { id: 'tdh.xtdh.grants', path: '/api/xtdh/grants?page_size=20' },
  { id: 'tdh.xtdh.collections', path: '/api/xtdh/collections?page_size=20' },
  { id: 'tdh.xtdh.tokens', path: '/api/xtdh/tokens?page_size=20' },
  { id: 'tdh.xtdh.grantees', path: '/api/xtdh/grantees?page_size=20' }
];

/**
 * TDH, its history and files, and xTDH.
 */
export const tdhManifest: AreaManifest = {
  area: 'tdh',
  flags: {},
  tables: {
    historic_tdh_consolidation: { class: 'INDEX' },
    nextgen_tokens_tdh: { class: 'INDEX' },
    tdh: { class: 'INDEX' },
    tdh_blocks: { class: 'INDEX' },
    tdh_consolidation: { class: 'INDEX' },
    tdh_editions: { class: 'INDEX' },
    tdh_editions_consolidation: { class: 'INDEX' },
    tdh_memes: { class: 'INDEX' },
    tdh_memes_consolidation: { class: 'INDEX' },
    tdh_nft: { class: 'INDEX' },
    identity_tdh_sync_scope: {
      class: 'EPHEMERAL',
      why: 'Sync scope for the identity TDH copy.'
    },
    identity_tdh_sync_state: {
      class: 'EPHEMERAL',
      why: 'Sync cursor for the identity TDH copy.'
    },
    latest_tdh_global_history: { class: 'INDEX' },
    latest_tdh_history: { class: 'INDEX' },
    recent_tdh_history: { class: 'INDEX' },
    tdh_global_history: { class: 'INDEX' },
    tdh_history: { class: 'INDEX' },
    uploads: { class: 'INDEX' },
    uploads_consolidation: { class: 'INDEX' },
    external_indexed_contracts: { class: 'INDEX' },
    external_indexed_ownership_721_histories: { class: 'INDEX' },
    external_indexed_ownership_721s: { class: 'INDEX' },
    external_indexed_transfers: { class: 'INDEX' },
    xtdh_grant_tokens: { class: 'INDEX' },
    xtdh_grants: { class: 'INDEX' },
    xtdh_identity_work: {
      class: 'EPHEMERAL',
      why: 'Temporary table of one session.',
      origin: 'runtime'
    },
    xtdh_stats_meta: { class: 'INDEX' },
    xtdh_token_grant_stats_a: { class: 'INDEX' },
    xtdh_token_grant_stats_b: { class: 'INDEX' },
    xtdh_token_stats_a: { class: 'INDEX' },
    xtdh_token_stats_b: { class: 'INDEX' },
    tdh_chain_days: { class: 'INDEX', origin: 'planned' }
  },
  seeds: [],
  rebuilders: [],
  probes: PROBES
};
