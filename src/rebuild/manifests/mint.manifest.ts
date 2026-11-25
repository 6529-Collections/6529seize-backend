import { createHash } from 'node:crypto';
import {
  PROBE_COLLAB_DROP,
  PROBE_MAIN_STAGE_WAVE,
  PROBE_PHASE_WALLETS
} from '@/mint-log/mint-log-rebuild.ids';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import {
  PROBE_CALLER,
  PROBE_MEME_IDS,
  PROBE_MEMES_CONTRACT,
  PROBE_WALLETS
} from '@/rebuild/manifests/probe-fixture';

/**
 * The team list's source is team.csv in this repository; the table is a
 * copy that the team loop writes. Before the drop the same loop wrote it.
 */
const saveTeamFromFile = (id: string): RebuildStep => ({
  id,
  run: { module: 'src/teamLoop/index', exportName: 'saveTeam' },
  writes: ['team'],
  sources: ['repo'],
  timeoutMinutes: 5
});

/**
 * The records service of a rebuild run, as the personal area's manifest
 * sets it (the run refuses two different values for one flag): the records
 * wave the mint rebuild reads the record log's heads from, and a provider
 * key made only for the rebuild check, derived from a public label.
 */
const FIXTURE_RECORDS_FLAGS = {
  SIGNED_RECORDS_PROVIDER_KEYS: JSON.stringify([
    {
      id: 'rebuild-fixture',
      private_key: `0x${createHash('sha256')
        .update('6529 rebuild check: fixture provider key, never a real one')
        .digest('hex')}`
    }
  ]),
  SIGNED_RECORDS_WAVE_ID: '00000000-0000-4000-8000-0000000000e1',
  SIGNED_RECORDS_SERVICE_PROFILE_ID: 'rebuild-records-service',
  SIGNED_RECORDS_SERVICE_WALLET: '0x00000000000000000000000000000000000000a1'
};

/**
 * The mint log's tables: what the rebuild writes whole
 * (mintRebuiltTables in src/mint-log/mint-log-rebuild.run.ts), and the
 * distribution loop's cursor, which it sets to the block it counted minted
 * counts up to.
 */
const MINT_LOG_TABLES = [
  'distribution',
  'distribution_normalized',
  'distribution_photo',
  'meme_card_drop_mappings',
  'meme_collaboration_invitations',
  'meme_collaborations',
  'mint_log_card_heads',
  'mint_log_head',
  'minting_claim_actions',
  'minting_claims',
  'minting_merkle_proofs',
  'minting_merkle_roots',
  'nextgen_allowlist',
  'nextgen_allowlist_burn',
  'nextgen_allowlist_collection',
  'nextgen_burn_collection',
  'rememes',
  'royalties_upload',
  'uploads_rememes',
  'transactions_processed_distribution_blocks'
];

/**
 * The rows the mint probes read, reached as production reaches them
 * (src/mint-log/mint-log-rebuild.seed.ts): card 1, a rememe and a royalties
 * upload before the log; the genesis (files in the run's seed files, entries
 * in the record log); logged writes through the minting writers with the
 * area's flags on (card 1's photos and a claim action, card 2, a rememe, an
 * upload of each kind, NextGen collections 1 and 2, a Main Stage
 * collaboration); the record log closed into a segment in the records wave;
 * then mint stats, on the chain's clock, and the minted counts from the NFT
 * and transactions loops.
 */
const MINT_PROBES_SEED: RebuildStep = {
  id: 'mint.probes.seed',
  run: {
    module: 'src/mint-log/mint-log-rebuild.seed',
    exportName: 'seedMintProbes'
  },
  writes: [
    ...MINT_LOG_TABLES,
    'memes_mint_stats',
    'signed_record_log_entries',
    'signed_record_log_segments',
    // The records service (identity, profile, records wave) when it is
    // missing, as personal's seed writes it; the Main Stage wave, the
    // collaboration's artwork and the records wave's head drops, with what
    // creating them writes (follows, the creator's group, the drop metrics;
    // not the subscriber count a follow adds); and the collaboration's
    // notifications.
    'identities',
    'address_consolidation_keys',
    'profiles',
    'waves',
    'drops',
    'drops_parts',
    'wave_metrics',
    'wave_dropper_metrics',
    'identity_subscriptions',
    'wave_group_notification_subscriptions',
    'identity_notifications'
  ],
  reads: ['nfts', 'transactions', 'subscriptions_redeemed', 'drops_metadatas'],
  // The holdings fixture's mints first: the mint stats and the minted
  // counts count them.
  after: ['holdings.seed'],
  sources: ['files', 'ethereum'],
  timeoutMinutes: 10
};

/**
 * The mint log's rebuild from empty: the genesis files, then every mint
 * entry of the record log in order, read from the records wave's head drops
 * and the segment files; then the minted counts and the loop's cursor from
 * the transactions (src/mint-log/mint-log-rebuild-check.steps.ts).
 */
const MINT_LOG_REBUILD: RebuildStep = {
  id: 'mint.log',
  run: {
    module: 'src/mint-log/mint-log-rebuild-check.steps',
    exportName: 'rebuildMintLogInCheck'
  },
  writes: MINT_LOG_TABLES,
  reads: [
    // The records wave: the head drops the records service posted.
    'drops',
    'drops_parts',
    // Minted counts after the cursor block, card names and mint dates.
    'transactions',
    'nfts',
    'nfts_meme_lab',
    // A card's state includes its subscription phases; the seed writes none.
    'subscriptions_nfts_final'
  ],
  // The transactions and NFTs it reads are the holdings rebuild's.
  after: ['holdings.ethereum'],
  sources: ['files'],
  timeoutMinutes: 30
};

/**
 * The merkle roots of cards 1 and 2's Phase 1, from the seed's allowlists
 * (PROBE_PHASE_WALLETS: 0x..b1 with as many spots as the card id, 0x..b2
 * with 3). No seed subscribes those wallets, so the roots are the same in
 * every run.
 */
const CARD_1_PHASE_1_ROOT =
  '0x7870e7e8fb1967594b80549011e3e19033d8789b750bbc4921ac91f0cfcce613';
const CARD_2_PHASE_1_ROOT =
  '0xd45c4af100eb6308c9a9e22033efe872f0cac5d4a12a1b9d24279118a6db1580';

/**
 * Mint stats, as the NFT loop writes them once a card's mint closes: for
 * each closed mint in the NFT index, from its paid mints, its redeemed
 * subscriptions and its claim's payment details. In the check a mint closes
 * on the chain's clock, the ethereum source's head block time, as in the
 * seed; production's rebuild (rebuildMemesMintStats) uses the wall clock.
 */
const MINT_STATS_REBUILD: RebuildStep = {
  id: 'mint.stats',
  run: {
    module: 'src/mint-log/mint-log-rebuild-check.steps',
    exportName: 'rebuildMemesMintStatsInCheck'
  },
  writes: ['memes_mint_stats'],
  reads: [
    'nfts',
    'transactions',
    'subscriptions_redeemed',
    'minting_claims',
    'drops_metadatas'
  ],
  // The NFTs and transactions are the holdings rebuild's, the claims the
  // mint log's. The redeemed subscriptions (subs) and the drop metadata
  // (waves) have no rebuilder yet; the registry asks for theirs here once
  // they do.
  after: ['holdings.ethereum', 'mint.log'],
  sources: ['ethereum'],
  timeoutMinutes: 10
};

/**
 * The announcement loop's done markers, one row per card and announcement:
 * written in the same transaction as the deployer's announcement drop, so
 * they follow from the announcement drops. A loss would repeat a public
 * announcement. Planned until the waves drop index is rebuilt; the step then
 * derives the rows from the deployer's drops in the announcement waves.
 */
const MINT_ANNOUNCEMENTS_REBUILD: RebuildStep = {
  id: 'mint.announcements',
  run: {
    module: 'src/mintAnnouncementsLoop/announcements-done.rebuild',
    exportName: 'rebuildAnnouncementsDone'
  },
  writes: [
    'mint_announcements_done_meme_tokens',
    'mint_end_announcements_done_meme_tokens',
    'public_phase_ending_soon_announcements_done_meme_tokens'
  ],
  reads: ['drops', 'drops_parts', 'nfts'],
  after: ['holdings.ethereum'],
  sources: ['repo'],
  timeoutMinutes: 10,
  origin: 'planned'
};

/** The mint answers: stats, distributions, claims and rememes. */
const PROBES: Probe[] = [
  { id: 'mint.stats', path: '/api/memes-mint-stats?page_size=20' },
  // Held until the artists entity is in the tree: the total joins artists.
  {
    id: 'mint.stats-total',
    path: '/api/memes-mint-stats/total',
    origin: 'planned',
    needs: ['artists']
  },
  { id: 'mint.stats-yearly', path: '/api/memes-mint-stats/yearly' },
  {
    id: 'mint.stats-card',
    path: '/api/memes-mint-stats/{id}',
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'mint.distributions',
    path: `/api/distributions?contract=${PROBE_MEMES_CONTRACT}&card_id={id}`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'mint.distribution-overview',
    path: `/api/distributions/${PROBE_MEMES_CONTRACT}/{id}/overview`,
    each: { id: PROBE_MEME_IDS },
    as: PROBE_CALLER
  },
  {
    id: 'mint.distribution-phases',
    path: `/api/distribution_phases/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'mint.distribution-photos',
    path: `/api/distribution_photos/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'mint.claims',
    path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/claims`,
    as: PROBE_CALLER
  },
  {
    id: 'mint.claim',
    path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/claims/{id}`,
    each: { id: PROBE_MEME_IDS },
    as: PROBE_CALLER
  },
  {
    id: 'mint.claim-actions',
    path: `/api/minting-claims/actions/${PROBE_MEMES_CONTRACT}/{id}`,
    each: { id: PROBE_MEME_IDS },
    as: PROBE_CALLER
  },
  {
    id: 'mint.claim-roots',
    path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/{id}/roots`,
    each: { id: PROBE_MEME_IDS }
  },
  {
    id: 'mint.claim-airdrops',
    path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/{id}/airdrops`,
    each: { id: PROBE_MEME_IDS }
  },
  // Sorted: the default order is random.
  {
    id: 'mint.rememes',
    path: '/api/rememes?page_size=20&sort=created_at',
    ignore: [
      {
        path: '$.data[*].updated_at',
        reason:
          'Moves with every provider refresh, which is not logged; a rebuilt row takes the time of the rebuild.'
      }
    ]
  },
  {
    id: 'mint.claim-allowlists',
    path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/{id}/allowlists`,
    each: { id: PROBE_MEME_IDS }
  },
  // Each card's Phase 1 root, as the seed's allowlists make it.
  ...[
    { id: '1', root: CARD_1_PHASE_1_ROOT },
    { id: '2', root: CARD_2_PHASE_1_ROOT }
  ].map(
    (card): Probe => ({
      id: `mint.claim-proofs-${card.id}`,
      path: `/api/minting-claims/${PROBE_MEMES_CONTRACT}/${card.id}/${card.root}/proofs/{wallet}`,
      each: { wallet: PROBE_PHASE_WALLETS }
    })
  ),
  {
    id: 'mint.claim-action-types',
    path: `/api/minting-claims/actions/${PROBE_MEMES_CONTRACT}/types`,
    as: PROBE_CALLER
  },
  {
    id: 'mint.wallet-allocations',
    path: `/api/distributions/${PROBE_MEMES_CONTRACT}/{id}/wallet-allocations?wallet={wallet}`,
    // The Phase 1 wallets: the allocations are a phase's spots.
    each: { id: PROBE_MEME_IDS, wallet: PROBE_PHASE_WALLETS }
  },
  {
    id: 'mint.artist-airdrops',
    path: `/api/distributions/${PROBE_MEMES_CONTRACT}/{id}/artist-airdrops`,
    each: { id: PROBE_MEME_IDS },
    as: PROBE_CALLER
  },
  {
    id: 'mint.team-airdrops',
    path: `/api/distributions/${PROBE_MEMES_CONTRACT}/{id}/team-airdrops`,
    each: { id: PROBE_MEME_IDS },
    as: PROBE_CALLER
  },
  {
    id: 'mint.collaboration',
    path: `/api/drops/${PROBE_COLLAB_DROP}/collaborations`,
    as: PROBE_CALLER
  },
  { id: 'mint.rememes-uploads', path: '/api/rememes_uploads' },
  { id: 'mint.royalties-uploads', path: '/api/royalties/uploads' },
  { id: 'mint.nextgen-phases', path: '/api/nextgen/allowlist_phases' },
  {
    id: 'mint.nextgen-proofs',
    path: `/api/nextgen/proofs/0x${'1'.repeat(64)}/{wallet}`,
    each: { wallet: PROBE_WALLETS }
  },
  {
    id: 'mint.nextgen-burn-proofs',
    path: `/api/nextgen/burn_proofs/0x${'2'.repeat(64)}/{token}`,
    each: { token: ['1', '2'] }
  },
  // The burn phase's collection with its burn registration.
  {
    id: 'mint.nextgen-burn-root',
    path: `/api/nextgen/merkle_roots/0x${'2'.repeat(64)}`
  }
];

/** Why a card's winning drop is neither seeded nor probed yet. */
const NO_MAIN_STAGE_WINNER =
  'Needs a Main Stage winner drop; the waves fixture has none yet.';

/**
 * Distributions, claims, NextGen allowlists, team, collaborations,
 * announcements, royalty uploads and rememes. Artists and the Meme Lab
 * royalties are in the holdings manifest.
 */
export const mintManifest: AreaManifest = {
  area: 'mint',
  // The mint area's flags for its new path. MAIN_STAGE_DECISION_IDS waits for
  // the chain's decision ids.
  flags: {
    ...FIXTURE_RECORDS_FLAGS,
    // The seed's Main Stage wave, where collaborations are invited.
    MAIN_STAGE_WAVE_ID: PROBE_MAIN_STAGE_WAVE,
    FEATURE_MINT_LOG_SHADOW: 'true',
    FEATURE_MINT_LOG_PRIMARY: 'true',
    FEATURE_MINT_LOG_REPLAY_CHECK: 'true',
    FEATURE_NEXTGEN_ALLOWLIST_SIGNED_FILE: 'true',
    FEATURE_REMEMES_KEEP_ADDED: 'true',
    FEATURE_MINT_HAND_LISTS: 'true',
    // Not a behaviour flag: the claims and distribution routes answer only
    // their admins, so the probe caller is one in the check's API.
    DISTRIBUTION_ADMIN_WALLETS: PROBE_WALLETS[0],
    CLAIMS_ADMIN_WALLETS: PROBE_WALLETS[0]
  },
  tables: {
    distribution: { class: 'INDEX' },
    distribution_normalized: { class: 'INDEX' },
    distribution_photo: { class: 'INDEX' },
    minting_merkle_proofs: { class: 'INDEX' },
    minting_merkle_roots: { class: 'INDEX' },
    // The distribution loop's cursor. Not ephemeral: lost, the loop would
    // add every mint to the minted counts again. The rebuild sets it.
    transactions_processed_distribution_blocks: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'created_at', reason: 'Set when the row is written.' }
      ]
    },
    meme_card_drop_mappings: { class: 'INDEX' },
    memes_mint_stats: { class: 'INDEX' },
    // Drop Forge's worker also writes these: claim actions when it completes
    // a launch's work (drop-forge.completion.ts), and the distribution
    // tables in background preparation (drop-forge.preparation.ts). Its
    // automatic artist payment reads the PAY_ARTIST action as its guard
    // against paying twice (drop-forge.payment.ts), so a rebuilder must
    // bring back actions set by hand too.
    minting_claim_actions: { class: 'INDEX' },
    minting_claims: { class: 'INDEX' },
    // Drop Forge (src/drop-forge): the automated launch of a claim's mint.
    // Its tables hold its operators' settings and records, its launches'
    // state, and markers that keep a report, a payment or an action from
    // happening twice. None is derived from a public source.
    drop_forge_settings: {
      class: 'EXEMPT',
      why: "Operator switches per chain and contract (automation, artist payment and its cap), set through the API by a claims admin or the creator contract's owner; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_launches: {
      class: 'EXEMPT',
      why: "Each launch's state machine: the frozen calendar and phase times, its actions and their transactions, and the reports still to post; the worker's own record, no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_signers: {
      class: 'EXEMPT',
      why: "The operational wallet's coordination row: which launch and action hold it while a transaction is outstanding; losing it could let a second transaction go out; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_preparations: {
      class: 'EXEMPT',
      why: "Each claim's preparation results, and whether its operator ran the preparation by hand or in the background; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_jobs: {
      class: 'EXEMPT',
      why: "Distribution jobs: their checkpoints, results, the encrypted credential until the input snapshot commits, and report acknowledgements, kept to prevent duplicate processing; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_evidence: {
      class: 'EXEMPT',
      why: "Transactions an operator sent by hand for a claim's actions, registered so a launch counts them and never repeats them; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_funding: {
      class: 'EXEMPT',
      why: "Gas top-ups an admin sent to the operational wallet and registered, with their replacement attempts and report acknowledgements, so each is reported once and a replacement is matched to its top-up; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    drop_forge_readiness_checks: {
      class: 'EXEMPT',
      why: "Once-only markers, per claim and phase, that a readiness report was posted to the operations wave, kept so it is never posted twice; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    nextgen_allowlist: { class: 'INDEX' },
    nextgen_allowlist_burn: { class: 'INDEX' },
    nextgen_allowlist_collection: { class: 'INDEX' },
    nextgen_burn_collection: { class: 'INDEX' },
    team: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'created_at', reason: 'Set when the loop writes the row.' }
      ]
    },
    meme_collaboration_invitations: { class: 'INDEX' },
    meme_collaborations: { class: 'INDEX' },
    mint_announcements_done_meme_tokens: { class: 'INDEX' },
    mint_end_announcements_done_meme_tokens: { class: 'INDEX' },
    public_phase_ending_soon_announcements_done_meme_tokens: {
      class: 'INDEX'
    },
    memes_prevote_artist_profiles: { class: 'INDEX' },
    royalties_upload: { class: 'INDEX' },
    rememes: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Moves with every provider refresh, which is not logged.'
        },
        {
          column: 's3_image_original',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_scaled',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_thumbnail',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_icon',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_processing_status',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_processing_error',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_last_attempt_at',
          reason: 'The S3 loop makes it again from the image.'
        },
        {
          column: 's3_image_processing_attempts',
          reason: 'The S3 loop makes it again from the image.'
        }
      ]
    },
    uploads_rememes: { class: 'INDEX' },
    mint_log_head: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Set when the rebuild writes the head.'
        }
      ]
    },
    mint_log_card_heads: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Set when the rebuild writes the head.'
        }
      ]
    }
  },
  seeds: [saveTeamFromFile('mint.team.seed'), MINT_PROBES_SEED],
  rebuilders: [
    saveTeamFromFile('mint.team'),
    MINT_LOG_REBUILD,
    MINT_STATS_REBUILD,
    MINT_ANNOUNCEMENTS_REBUILD
  ],
  probes: PROBES,
  waivers: {
    routes: [
      {
        target: 'GET /api/meme-cards/{meme_card_id}/drop',
        reason: NO_MAIN_STAGE_WINNER
      }
    ],
    unseededTables: [
      { target: 'meme_card_drop_mappings', reason: NO_MAIN_STAGE_WINNER }
    ],
    unprobedTables: [
      { target: 'meme_card_drop_mappings', reason: NO_MAIN_STAGE_WINNER },
      {
        target: 'team',
        reason:
          'No GET route reads it; minting claims read it when an admin sets an edition size.'
      },
      {
        target: 'mint_log_head',
        reason:
          "No GET route reads it: the mint log's sequence heads; its rows are compared."
      },
      {
        target: 'mint_log_card_heads',
        reason:
          "No GET route reads it: each collaboration's sequence head; its rows are compared."
      },
      {
        target: 'transactions_processed_distribution_blocks',
        reason:
          "No GET route reads it: the distribution loop's cursor; its rows are compared."
      }
    ]
  }
};
