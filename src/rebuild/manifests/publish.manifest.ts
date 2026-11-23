import { createHash } from 'node:crypto';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import { PROBE_CALLER, PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import {
  PUBLISH_SEED_IDS,
  PUBLISH_SEED_PROFILE,
  publishSeedSites
} from '@/rebuild/areas/publish.fixture';

/**
 * The records service of a rebuild run: a fake wave, profile and wallet,
 * and a provider key made only for the rebuild check, derived from a
 * public label so it can never be mistaken for a real one. The same
 * values as the personal area's: the run refuses a flag two manifests set
 * differently, so the two can't drift apart.
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

const SITES = publishSeedSites();

/**
 * The profile-site and CMS answers. The publish seed publishes a site for
 * the first probe profile, keeps a second draft, and issues an agent grant
 * with a proposal on it.
 */
const PROBES: Probe[] = [
  {
    id: 'publish.cms-primary',
    path: '/api/cms/profile/{wallet}/primary',
    each: { wallet: PROBE_WALLETS }
  },
  { id: 'publish.cms-my-sites', path: '/api/cms/my/sites', as: PROBE_CALLER },
  {
    id: 'publish.cms-package',
    path: '/api/cms/packages/{package_hash}',
    each: { package_hash: [SITES.published.packageHash] }
  },
  {
    id: 'publish.profile-cms-primary',
    path: '/api/profile-cms/{handle}/primary',
    each: { handle: [PUBLISH_SEED_PROFILE, PROBE_WALLETS[0]] }
  },
  {
    id: 'publish.profile-cms-packages',
    path: '/api/profile-cms/profiles/{profile_id}/packages',
    each: { profile_id: [PUBLISH_SEED_PROFILE] }
  },
  {
    id: 'publish.profile-cms-package',
    path: '/api/profile-cms/packages/{id}',
    each: { id: [SITES.published.draftId, SITES.draft.draftId] },
    as: PROBE_CALLER
  },
  {
    id: 'publish.profile-cms-package-by-hash',
    path: '/api/profile-cms/packages/by-hash/{package_hash}',
    each: { package_hash: [SITES.published.packageHash] }
  },
  {
    id: 'publish.profile-cms-version',
    path: '/api/profile-cms/profiles/{profile_id}/packages/{package_id}/versions/{version}',
    each: {
      profile_id: [PUBLISH_SEED_PROFILE],
      package_id: [SITES.published.cmsPackage.package_id],
      // Only published versions are public.
      version: ['1']
    }
  },
  {
    id: 'publish.profile-cms-export',
    path: '/api/profile-cms/packages/{id}/export',
    each: { id: [SITES.published.draftId] },
    as: PROBE_CALLER
  },
  {
    id: 'publish.profile-cms-source-packet',
    path: '/api/profile-cms/packages/{id}/agent/source-packet',
    each: { id: [SITES.draft.draftId] },
    as: PROBE_CALLER,
    ignore: [
      {
        path: '$.generated_at',
        reason: 'When the packet was made: the time of the request.'
      },
      {
        path: '$.validation_diagnostics.live_result.checked_at',
        reason:
          'When the draft was validated for the packet: the time of the request.'
      }
    ]
  },
  {
    id: 'publish.profile-cms-agent-grants',
    path: '/api/profile-cms/packages/{id}/agent-grants',
    each: { id: [SITES.draft.draftId] },
    as: PROBE_CALLER
  },
  {
    id: 'publish.profile-cms-agent-proposals',
    path: '/api/profile-cms/packages/{id}/agent-proposals',
    each: { id: [SITES.draft.draftId] },
    as: PROBE_CALLER
  },
  {
    id: 'publish.profile-cms-agent-proposal',
    path: '/api/profile-cms/agent-proposals/{id}',
    each: { id: [PUBLISH_SEED_IDS.proposal] },
    as: PROBE_CALLER
  }
];

const PUBLISH_TABLES = [
  'profile_cms_packages',
  'profile_cms_pointer_events',
  'profile_cms_publish_signatures',
  'profile_cms_agent_grants',
  'profile_cms_agent_proposals',
  'profile_cms_agent_events',
  'profile_cms_chain_heads',
  'profile_cms_chain_parked',
  'cms_sites',
  'cms_published_packages'
];

/**
 * The world before the drop, on 6529.io's own path with the private log on
 * (src/rebuild/areas/publish.seed.ts).
 */
const PUBLISH_SEED: RebuildStep = {
  id: 'publish.seed',
  run: {
    module: 'src/rebuild/areas/publish.seed',
    exportName: 'seedProfileSites'
  },
  writes: [
    'profile_cms_packages',
    'profile_cms_pointer_events',
    'profile_cms_publish_signatures',
    'profile_cms_agent_grants',
    'profile_cms_agent_proposals',
    'profile_cms_agent_events',
    'signed_record_log_entries',
    'signed_record_log_segments',
    'identity_subscriptions',
    'identities',
    'address_consolidation_keys',
    'profiles',
    'waves',
    'drops',
    'drops_parts'
  ],
  reads: ['profile_cms_chain_heads'],
  // The first probe profile's identity first.
  after: ['identity.probe-profiles'],
  sources: ['files', 'repo'],
  timeoutMinutes: 10
};

/**
 * The chain half of the world: people's Profile changes naming their sites,
 * followed live. It needs the identity mirror's gateway adapter wired into
 * createProfileCmsChainPort, and Profile changes in a devnet recording of
 * the gateway; until then the area runs with
 * FEATURE_PROFILE_CMS_CHAIN_POINTER off, and its rebuild reads no chain.
 */
const PUBLISH_CHAIN_SEED: RebuildStep = {
  id: 'publish.chain-seed',
  run: {
    module: 'src/profile-cms/chain/profile-cms-chain.seed',
    exportName: 'seedProfileSitesFromChain'
  },
  writes: PUBLISH_TABLES,
  after: ['publish.seed'],
  sources: ['gateway', 'files'],
  timeoutMinutes: 15,
  origin: 'planned'
};

/**
 * Every profile site table from empty: the chain's Profile changes when
 * FEATURE_PROFILE_CMS_CHAIN_POINTER is on, and the private record log's
 * entries, each after the chain change it was stamped with.
 */
const PUBLISH_REBUILD: RebuildStep = {
  id: 'publish.chain-and-log',
  run: {
    module: 'src/profile-cms/personal-log/profile-cms-rebuild',
    exportName: 'rebuildProfileCmsFromChainAndLog'
  },
  writes: PUBLISH_TABLES,
  // The records wave's head drops (the records service's posts).
  reads: ['drops', 'drops_parts'],
  sources: ['gateway', 'files'],
  timeoutMinutes: 15
};

/**
 * Profile sites and legacy CMS sites.
 */
export const publishManifest: AreaManifest = {
  area: 'publish',
  flags: {
    // FEATURE_PROFILE_CMS_CHAIN_POINTER stays off, its shipping default,
    // until the chain half above is in the run.
    FEATURE_PROFILE_CMS_PERSONAL_LOG: 'true',
    FEATURE_SIGNED_RECORD_LOG: 'true',
    ...FIXTURE_RECORDS_FLAGS
  },
  tables: {
    profile_cms_agent_events: { class: 'INDEX' },
    profile_cms_agent_grants: {
      class: 'INDEX',
      volatileColumns: [{ column: 'request_count', reason: 'A rate counter.' }]
    },
    profile_cms_agent_proposals: { class: 'INDEX' },
    profile_cms_packages: { class: 'INDEX' },
    profile_cms_pointer_events: { class: 'INDEX' },
    profile_cms_publish_signatures: { class: 'INDEX' },
    profile_cms_uploads: {
      class: 'EPHEMERAL',
      why: 'Upload leases, resume checkpoints and the 24-hour quota count; a loss costs at most one repeated upload.'
    },
    cms_published_packages: { class: 'INDEX' },
    cms_sites: { class: 'INDEX' },
    profile_cms_chain_heads: { class: 'INDEX' },
    // Chain versions the follower couldn't apply yet; the change feed
    // fills it again on a rebuild.
    profile_cms_chain_parked: { class: 'INDEX' }
  },
  seeds: [PUBLISH_SEED, PUBLISH_CHAIN_SEED],
  rebuilders: [PUBLISH_REBUILD],
  probes: PROBES,
  waivers: {
    routes: [
      {
        target: 'GET /api/profile-cms/agent/schema-bundle',
        reason: 'Serves the CMS agent schema from the code; it reads no table.'
      },
      {
        target: 'GET /api/profile-cms/agent-session/draft',
        reason:
          "Answers only to an agent's grant token, which the probes can't present; the draft it reads is probed through GET /api/profile-cms/packages/{id}."
      },
      {
        target: 'GET /api/profile-cms/agent-session/proposals/{id}',
        reason:
          "Answers only to an agent's grant token, which the probes can't present; the proposal it reads is probed through GET /api/profile-cms/agent-proposals/{id}."
      }
    ],
    unprobedTables: [
      {
        target: 'profile_cms_publish_signatures',
        reason:
          'Marks each publish signature consumed, so it cannot be used twice; no route returns it. The rebuild check compares its rows one by one.'
      },
      {
        target: 'profile_cms_agent_events',
        reason:
          "An agent grant's audit trail; no route returns it. The rebuild check compares its rows one by one."
      },
      {
        target: 'profile_cms_chain_heads',
        reason:
          "The chain follower's own cursor: the last ProfileDoc version applied per principal. No route reads it."
      },
      {
        target: 'profile_cms_chain_parked',
        reason:
          'Chain changes the follower could not apply yet, retried each pass. No route reads it.'
      }
    ],
    unseededTables: [
      {
        target: 'profile_cms_chain_parked',
        reason:
          'Holds only changes that cannot be applied yet; a settled world has none.'
      }
    ]
  }
};
