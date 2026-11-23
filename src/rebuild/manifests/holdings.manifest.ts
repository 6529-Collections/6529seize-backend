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
  {
    id: 'holdings.nextgen.collections',
    path: '/api/nextgen/collections',
    ignore: writtenAt('$.data[*].created_at', '$.data[*].updated_at')
  },
  {
    id: 'holdings.nextgen.tokens',
    path: '/api/nextgen/collections/1/tokens?page_size=20',
    ignore: writtenAt('$.data[*].created_at', '$.data[*].updated_at')
  },
  { id: 'holdings.nextgen.traits', path: '/api/nextgen/collections/1/traits' },
  {
    id: 'holdings.nextgen.logs',
    path: '/api/nextgen/collections/1/logs',
    ignore: writtenAt('$.data[*].created_at')
  },
  { id: 'holdings.artists', path: '/api/memes/artists_names' },
  {
    id: 'holdings.meme-lab-royalties',
    path: '/api/royalties/collection/memelab?from_block=0&to_block=100000000'
  }
];

/**
 * Holdings and the Ethereum indexes: transactions, NFTs, history, NextGen,
 * ENS, market stats and link cards.
 */
const step = (module: string, exportName: string) => ({ module, exportName });

/** Columns the loops set to the time they write a row (`new Date()`). */
const writeTimes = (...columns: string[]) => ({
  volatileColumns: columns.map((column) => ({
    column,
    reason: 'The time the loop wrote the row; each pass writes it anew.'
  }))
});
const CREATED = writeTimes('created_at');
const CREATED_UPDATED = writeTimes('created_at', 'updated_at');

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
const NEXTGEN_TABLES = [
  'nextgen_collections',
  'nextgen_logs',
  'nextgen_tokens',
  'nextgen_token_traits',
  'nextgen_token_scores',
  'nextgen_blocks'
];
const WALLET_TRANSFER_TABLES = [
  'wallet_transfer_pair_days',
  'wallet_transfer_wallet_days',
  'wallet_transfer_analysis_states'
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
 * The probe fixture's world on the run's anvil (cards 1-4 of the Memes,
 * card 4 through a Manifold claim, Meme Lab card 1, NextGen collection 1,
 * wallets 1 and 2), then the holdings tables from it. Its contracts are
 * test fixtures; holdings-seed.ts says what each stands for.
 */
/** Every table the seed writes, each whole. */
const SEEDED_TABLES = [
  'transactions',
  'transfer_reconciliations',
  'nft_owners',
  'nft_owners_consolidation',
  'nft_owners_sync_state',
  ...CATALOGUE_TABLES,
  ...HISTORY_TABLES,
  ...HOLDINGS_TABLES,
  ...NEXTGEN_TABLES,
  'meme_lab_royalties',
  ...WALLET_TRANSFER_TABLES
];

const HOLDINGS_SEED: RebuildStep = {
  id: 'holdings.seed',
  run: step('src/holdings/rebuild-seed/holdings-seed', 'seedHoldings'),
  writes: SEEDED_TABLES,
  reads: ['eth_price', 'address_consolidation_keys', 'tdh_nft'],
  // The fixture wallets' consolidation keys first.
  after: ['identity.probe-profiles'],
  sources: ['ethereum', 'files', 'repo'],
  timeoutMinutes: 30
};

const HOLDINGS_REBUILDERS: RebuildStep[] = [
  {
    id: 'holdings.ethereum',
    run: step('src/holdings/rebuild-seed/holdings-seed', 'rebuildHoldings'),
    writes: SEEDED_TABLES.filter(
      (table) => !WALLET_TRANSFER_TABLES.includes(table)
    ),
    // tdh_nft is TDH's, rebuilt after this step, since TDH reads the
    // transactions this step writes. The catalogue's ranks read it and keep
    // the legacy ranks when the read fails or finds no rows, as in the seed,
    // which also runs before TDH's.
    reads: (HOLDINGS_SEED.reads ?? []).filter((table) => table !== 'tdh_nft'),
    sources: ['ethereum', 'files', 'repo'],
    timeoutMinutes: 60
  },
  {
    id: 'holdings.wallet-transfers',
    run: step(
      'src/wallet-transfer-analysis/wallet-transfer-rebuild',
      'rebuildWalletTransferAnalysis'
    ),
    writes: WALLET_TRANSFER_TABLES,
    reads: ['transactions'],
    after: ['holdings.ethereum'],
    sources: [],
    timeoutMinutes: 15
  }
];

export const holdingsManifest: AreaManifest = {
  area: 'holdings',
  // Token metadata from the run's files source instead of the gateways.
  flags: {
    DECENTRALIZED_MEDIA_FILES_URL: '{files}',
    // The check's chain starts at block 0, not at the NextGen deploy block.
    NEXTGEN_START_BLOCK_OVERRIDE: '0'
  },
  tables: {
    eth_price: {
      class: 'PROVIDER',
      why: 'USD price from the price provider.'
    },
    transactions: { class: 'INDEX', ...CREATED },
    transfer_reconciliations: { class: 'INDEX', ...writeTimes('requested_at') },
    // Where the analysis has got to; rebuilt with its two tables.
    wallet_transfer_analysis_states: {
      class: 'INDEX',
      ...writeTimes('updated_at')
    },
    wallet_transfer_pair_days: { class: 'INDEX' },
    wallet_transfer_wallet_days: { class: 'INDEX' },
    lab_extended_data: { class: 'INDEX', ...CREATED },
    memes_extended_data: { class: 'INDEX', ...CREATED },
    memes_seasons: { class: 'INDEX', ...CREATED },
    nft_owners: { class: 'INDEX', ...CREATED_UPDATED },
    // The block nft_owners reflects; rebuilt with it.
    nft_owners_sync_state: { class: 'INDEX' },
    nfts: { class: 'INDEX', ...CREATED },
    nfts_meme_lab: { class: 'INDEX', ...CREATED },
    s3_uploader_outbox: {
      class: 'EPHEMERAL',
      why: 'Media upload outbox.'
    },
    nfts_history: { class: 'INDEX', ...CREATED },
    // The checkpoint of what nfts_history holds; rebuilt with it, since the
    // history step resumes after it.
    nfts_history_blocks: { class: 'INDEX', ...CREATED },
    nfts_history_claims: { class: 'INDEX', ...CREATED },
    nfts_history_events: { class: 'INDEX', ...CREATED },
    nfts_history_replay_jobs: {
      class: 'EPHEMERAL',
      why: 'Replay job queue.'
    },
    // The block the NextGen tables reflect; rebuilt with them.
    nextgen_blocks: { class: 'INDEX', ...CREATED },
    nextgen_collections: { class: 'INDEX', ...CREATED_UPDATED },
    nextgen_logs: { class: 'INDEX', ...CREATED },
    nextgen_token_listings: {
      class: 'PROVIDER',
      why: 'Marketplace listings.'
    },
    nextgen_token_scores: { class: 'INDEX', ...CREATED_UPDATED },
    nextgen_token_traits: { class: 'INDEX', ...CREATED_UPDATED },
    nextgen_tokens: { class: 'INDEX', ...CREATED_UPDATED },
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
    aggregated_activity: { class: 'INDEX', ...CREATED_UPDATED },
    aggregated_activity_consolidation: { class: 'INDEX', ...CREATED_UPDATED },
    aggregated_activity_memes: { class: 'INDEX', ...CREATED_UPDATED },
    aggregated_activity_memes_consolidation: {
      class: 'INDEX',
      ...CREATED_UPDATED
    },
    nft_owners_consolidation: { class: 'INDEX', ...CREATED_UPDATED },
    owners_balances: { class: 'INDEX', ...CREATED_UPDATED },
    owners_balances_consolidation: { class: 'INDEX', ...CREATED_UPDATED },
    owners_balances_memes: { class: 'INDEX', ...CREATED_UPDATED },
    owners_balances_memes_consolidation: { class: 'INDEX', ...CREATED_UPDATED },
    // The NFT catalogue's artists and the Meme Lab royalties.
    artists: { class: 'INDEX', ...CREATED },
    meme_lab_royalties: { class: 'INDEX' }
  },
  seeds: [HOLDINGS_SEED],
  rebuilders: HOLDINGS_REBUILDERS,
  probes: PROBES,
  waivers: {
    unseededTables: [
      {
        target: 'meme_lab_royalties',
        reason:
          "Rebuilt from src/holdings/meme-lab-royalties.json, which is empty until the team exports production's splits; the step writes nothing while it is."
      },
      {
        target: 'transfer_reconciliations',
        reason:
          "The queue between the holdings loops; a complete run, the seed's or the rebuild's, leaves it empty."
      }
    ],
    unprobedTables: [
      {
        target: 'nft_owners_sync_state',
        reason:
          'The block the NFT owners reflect. Only the collect routes read it, beside marketplace orders the check does not serve.'
      },
      {
        target: 'nextgen_blocks',
        reason: "The NextGen loop's checkpoint; no route reads it."
      },
      {
        target: 'wallet_transfer_analysis_states',
        reason: "The wallet transfer analysis's checkpoint; no route reads it."
      },
      {
        target: 'wallet_transfer_pair_days',
        reason:
          'Read by the wallet transfer analysis report, an operator command, not a route.'
      },
      {
        target: 'wallet_transfer_wallet_days',
        reason:
          'Read by the wallet transfer analysis report, an operator command, not a route.'
      },
      {
        target: 'nfts_history_blocks',
        reason: "The NFT history loop's checkpoint; no route reads it."
      },
      {
        target: 'nfts_history_claims',
        reason:
          'Claim state the history loop keeps for its own decoding; no route reads it.'
      },
      {
        target: 'transfer_reconciliations',
        reason: 'The queue between the holdings loops; no route reads it.'
      }
    ]
  }
};
