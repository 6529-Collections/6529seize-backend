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
 * The rows the mint probes read, written through the mint code's own write
 * paths: claims 1 and 2 on the cards of the same ids, a rememe on contract
 * 0x...03, NextGen collection 1.
 */
const MINT_PROBES_SEED: RebuildStep = {
  id: 'mint.probes.seed',
  run: {
    module: 'src/mint-log/mint-log-rebuild.seed',
    exportName: 'seedMintProbes'
  },
  writes: [
    'distribution',
    'distribution_normalized',
    'distribution_photo',
    'minting_merkle_roots',
    'minting_merkle_proofs',
    'minting_claims',
    'minting_claim_actions',
    'memes_mint_stats',
    'rememes',
    'uploads_rememes',
    'royalties_upload',
    'nextgen_allowlist_collection',
    'nextgen_allowlist',
    'mint_log_head',
    'signed_record_log_entries'
  ],
  // The holdings fixture's mints first: the mint stats count them.
  after: ['holdings.seed'],
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
  { id: 'mint.rememes', path: '/api/rememes?page_size=20' },
  { id: 'mint.rememes-uploads', path: '/api/rememes_uploads' },
  { id: 'mint.royalties-uploads', path: '/api/royalties/uploads' },
  { id: 'mint.nextgen-phases', path: '/api/nextgen/allowlist_phases' }
];

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
    transactions_processed_distribution_blocks: {
      class: 'EPHEMERAL',
      why: 'Loop cursor.'
    },
    meme_card_drop_mappings: { class: 'INDEX' },
    memes_mint_stats: { class: 'INDEX' },
    minting_claim_actions: { class: 'INDEX' },
    minting_claims: { class: 'INDEX' },
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
      origin: 'planned',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Set when the rebuild writes the head.'
        }
      ]
    },
    mint_log_card_heads: {
      class: 'INDEX',
      origin: 'planned',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Set when the rebuild writes the head.'
        }
      ]
    }
  },
  seeds: [saveTeamFromFile('mint.team.seed'), MINT_PROBES_SEED],
  rebuilders: [saveTeamFromFile('mint.team')],
  probes: PROBES,
  waivers: {
    unprobedTables: [
      {
        target: 'team',
        reason:
          'No GET route reads it; minting claims read it when an admin sets an edition size.'
      }
    ]
  }
};
