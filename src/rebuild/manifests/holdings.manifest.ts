import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import {
  PROBE_CONSOLIDATION_KEYS,
  PROBE_MEME_IDS,
  PROBE_MEMES_CONTRACT,
  PROBE_WALLETS
} from '@/rebuild/manifests/probe-fixture';

/** Write times: each pass writes its rows anew. */
const writtenAt = (...paths: string[]) =>
  paths.map((path) => ({ path, reason: 'The time the row was written.' }));

/** The answers the holdings tables feed, for the probe fixture's wallets. */
const PROBES: Probe[] = [
  {
    id: 'holdings.owners-balances',
    path: '/api/owners-balances?page_size=20',
    ignore: writtenAt('$.data[*].created_at', '$.data[*].updated_at')
  },
  {
    id: 'holdings.owners-balances.consolidation',
    path: '/api/owners-balances/consolidation/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: writtenAt('$.created_at', '$.updated_at')
  },
  {
    id: 'holdings.owners-balances.consolidation-memes',
    path: '/api/owners-balances/consolidation/{key}/memes',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: writtenAt('$[*].created_at', '$[*].updated_at')
  },
  {
    id: 'holdings.owners-balances.wallet',
    path: '/api/owners-balances/wallet/{wallet}',
    each: { wallet: PROBE_WALLETS },
    ignore: writtenAt('$.created_at', '$.updated_at')
  },
  {
    id: 'holdings.owners-balances.wallet-memes',
    path: '/api/owners-balances/wallet/{wallet}/memes',
    each: { wallet: PROBE_WALLETS },
    ignore: writtenAt('$[*].created_at', '$[*].updated_at')
  },
  {
    id: 'holdings.aggregated-activity',
    path: '/api/aggregated-activity?page_size=20'
  },
  {
    id: 'holdings.aggregated-activity.consolidation',
    path: '/api/aggregated-activity/consolidation/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: writtenAt('$.created_at', '$.updated_at')
  },
  {
    id: 'holdings.aggregated-activity.consolidation-memes',
    path: '/api/aggregated-activity/consolidation/{key}/memes',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: writtenAt('$[*].created_at', '$[*].updated_at')
  },
  {
    id: 'holdings.aggregated-activity.wallet',
    path: '/api/aggregated-activity/wallet/{wallet}',
    each: { wallet: PROBE_WALLETS },
    ignore: writtenAt('$.created_at', '$.updated_at')
  },
  {
    id: 'holdings.aggregated-activity.wallet-memes',
    path: '/api/aggregated-activity/wallet/{wallet}/memes',
    each: { wallet: PROBE_WALLETS },
    ignore: writtenAt('$[*].created_at', '$[*].updated_at')
  },
  {
    id: 'holdings.nft-owners',
    path: `/api/nft-owners?contract=${PROBE_MEMES_CONTRACT}&token_id={id}`,
    each: { id: PROBE_MEME_IDS },
    ignore: writtenAt('$.data[*].created_at', '$.data[*].updated_at')
  },
  {
    id: 'holdings.nft-owners.consolidation',
    path: '/api/nft-owners/consolidation/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS },
    ignore: writtenAt('$.data[*].created_at', '$.data[*].updated_at')
  },
  {
    id: 'holdings.collected-stats',
    path: '/api/collected-stats/{key}',
    each: { key: PROBE_CONSOLIDATION_KEYS }
  },
  {
    id: 'holdings.nfts',
    path: `/api/nfts?contract=${PROBE_MEMES_CONTRACT}&page_size=20`,
    ignore: writtenAt('$.data[*].created_at')
  },
  {
    id: 'holdings.nfts-memelab',
    path: '/api/nfts_memelab?page_size=20',
    ignore: writtenAt('$.data[*].created_at')
  },
  {
    id: 'holdings.memes-extended-data',
    path: '/api/memes_extended_data?page_size=20',
    ignore: writtenAt('$.data[*].created_at')
  },
  {
    id: 'holdings.lab-extended-data',
    path: '/api/lab_extended_data',
    ignore: writtenAt('$.data[*].created_at')
  },
  {
    id: 'holdings.memes-seasons',
    path: '/api/new_memes_seasons',
    ignore: writtenAt('$[*].created_at')
  },
  {
    id: 'holdings.transactions',
    path: '/api/transactions?page_size=20',
    ignore: writtenAt('$.data[*].created_at')
  },
  {
    id: 'holdings.nft-history',
    path: `/api/nft_history/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS },
    ignore: writtenAt('$.data[*].created_at')
  },
  { id: 'holdings.nextgen.collections', path: '/api/nextgen/collections' },
  {
    id: 'holdings.nextgen.tokens',
    path: '/api/nextgen/collections/1/tokens?page_size=20'
  },
  { id: 'holdings.nextgen.traits', path: '/api/nextgen/collections/1/traits' },
  { id: 'holdings.nextgen.logs', path: '/api/nextgen/collections/1/logs' },
  // Held until the artists and Meme Lab royalties entities are in the tree:
  // without their tables these routes answer 500 on a fresh database.
  {
    id: 'holdings.artists',
    path: '/api/memes/artists_names',
    origin: 'planned',
    needs: ['artists']
  },
  {
    id: 'holdings.meme-lab-royalties',
    path: '/api/royalties/collection/memelab?from_block=0&to_block=100000000',
    origin: 'planned',
    needs: ['meme_lab_royalties']
  }
];

/**
 * Holdings and the Ethereum indexes: transactions, NFTs, history, NextGen,
 * ENS, market stats and link cards.
 * Classes start from the migration map; the area confirms or changes each one.
 */
const step = (module: string, exportName: string) => ({ module, exportName });

const HISTORY_TABLES = [
  'nfts_history',
  'nfts_history_events',
  'nfts_history_claims',
  'nfts_history_blocks'
];
const HOLDINGS_TABLES = [
  'aggregated_activity',
  'aggregated_activity_memes',
  'aggregated_activity_consolidation',
  'aggregated_activity_memes_consolidation',
  'owners_balances',
  'owners_balances_memes',
  'owners_balances_consolidation',
  'owners_balances_memes_consolidation'
];
const CATALOGUE_TABLES = [
  'nfts',
  'nfts_meme_lab',
  'memes_extended_data',
  'lab_extended_data',
  'memes_seasons',
  'artists'
];

/**
 * The probe fixture's world on the run's anvil (cards 1-3 of the Memes,
 * Meme Lab card 1, wallets 1 and 2), then the holdings tables from it.
 */
const HOLDINGS_SEED: RebuildStep = {
  id: 'holdings.seed',
  run: step('src/holdings/rebuild-seed/holdings-seed', 'seedHoldings'),
  writes: [
    'transactions',
    'transfer_reconciliations',
    'nft_owners',
    'nft_owners_consolidation',
    'nft_owners_sync_state',
    ...CATALOGUE_TABLES,
    ...HISTORY_TABLES,
    ...HOLDINGS_TABLES,
    'meme_lab_royalties'
  ],
  reads: ['eth_price', 'address_consolidation_keys', 'tdh_nft'],
  // The fixture wallets' consolidation keys first.
  after: ['harness.probe-identities'],
  sources: ['ethereum', 'files', 'repo'],
  timeoutMinutes: 30,
  origin: 'planned'
};

const HOLDINGS_REBUILDERS: RebuildStep[] = [
  {
    id: 'holdings.ethereum',
    run: step('src/holdings/rebuild-seed/holdings-seed', 'rebuildHoldings'),
    writes: HOLDINGS_SEED.writes,
    reads: HOLDINGS_SEED.reads,
    sources: ['ethereum', 'files', 'repo'],
    timeoutMinutes: 60,
    origin: 'planned'
  }
];

export const holdingsManifest: AreaManifest = {
  area: 'holdings',
  // Token metadata from the run's files source instead of the gateways.
  flags: { DECENTRALIZED_MEDIA_FILES_URL: '{files}' },
  tables: {
    eth_price: {
      class: 'PROVIDER',
      why: 'USD price from the price provider.'
    },
    transactions: { class: 'INDEX' },
    transfer_reconciliations: { class: 'INDEX' },
    wallet_transfer_analysis_states: {
      class: 'EPHEMERAL',
      why: 'Analysis cursor.'
    },
    wallet_transfer_pair_days: { class: 'INDEX' },
    wallet_transfer_wallet_days: { class: 'INDEX' },
    lab_extended_data: { class: 'INDEX' },
    memes_extended_data: { class: 'INDEX' },
    memes_seasons: { class: 'INDEX' },
    nft_owners: { class: 'INDEX' },
    // The block nft_owners reflects; rebuilt with it.
    nft_owners_sync_state: { class: 'INDEX' },
    nfts: { class: 'INDEX' },
    nfts_meme_lab: { class: 'INDEX' },
    s3_uploader_outbox: {
      class: 'EPHEMERAL',
      why: 'Media upload outbox.'
    },
    nfts_history: { class: 'INDEX' },
    // The checkpoint of what nfts_history holds; rebuilt with it, since the
    // history step resumes after it.
    nfts_history_blocks: { class: 'INDEX' },
    nfts_history_claims: { class: 'INDEX' },
    nfts_history_events: { class: 'INDEX' },
    nfts_history_replay_jobs: {
      class: 'EPHEMERAL',
      why: 'Replay job queue.'
    },
    nextgen_blocks: { class: 'EPHEMERAL', why: 'Loop cursor.' },
    nextgen_collections: { class: 'INDEX' },
    nextgen_logs: { class: 'INDEX' },
    nextgen_token_listings: {
      class: 'PROVIDER',
      why: 'Marketplace listings.'
    },
    nextgen_token_scores: { class: 'INDEX' },
    nextgen_token_traits: { class: 'INDEX' },
    nextgen_tokens: { class: 'INDEX' },
    ens: {
      class: 'PROVIDER',
      why: 'ENS names, fetched again from ENS.'
    },
    market_depth_collection_state: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_current_orders: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_cursors: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_events: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_publication_locks: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_reconciliation_queue: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    market_depth_snapshots: {
      class: 'PROVIDER',
      why: 'Marketplace order books and their bookkeeping.'
    },
    nft_links: {
      class: 'PROVIDER',
      why: 'Link cards fetched from marketplaces, keyed by URLs in drops.'
    },
    aggregated_activity: { class: 'INDEX' },
    aggregated_activity_consolidation: { class: 'INDEX' },
    aggregated_activity_memes: { class: 'INDEX' },
    aggregated_activity_memes_consolidation: { class: 'INDEX' },
    nft_owners_consolidation: { class: 'INDEX' },
    owners_balances: { class: 'INDEX' },
    owners_balances_consolidation: { class: 'INDEX' },
    owners_balances_memes: { class: 'INDEX' },
    owners_balances_memes_consolidation: { class: 'INDEX' },
    // The NFT catalogue's artists and the Meme Lab royalties. Neither has
    // an entity yet, so a fresh schema lacks both.
    artists: { class: 'INDEX' },
    meme_lab_royalties: { class: 'INDEX' }
  },
  seeds: [HOLDINGS_SEED],
  rebuilders: HOLDINGS_REBUILDERS,
  probes: PROBES
};
