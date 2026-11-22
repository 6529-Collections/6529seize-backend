import { AreaManifest, Probe } from '@/rebuild/manifest.types';
import { PROBE_CALLER, PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';

/**
 * The profile-site and CMS answers for the probe fixture's wallets. They
 * prove something once the area's seed publishes a site for one of them.
 */
const PROBES: Probe[] = [
  {
    id: 'publish.cms-primary',
    path: '/api/cms/profile/{wallet}/primary',
    each: { wallet: PROBE_WALLETS }
  },
  { id: 'publish.cms-my-sites', path: '/api/cms/my/sites', as: PROBE_CALLER },
  {
    id: 'publish.profile-cms-primary',
    path: '/api/profile-cms/{wallet}/primary',
    each: { wallet: PROBE_WALLETS }
  },
  {
    id: 'publish.profile-cms-packages',
    path: '/api/profile-cms/profiles/{wallet}/packages',
    each: { wallet: PROBE_WALLETS }
  },
  {
    id: 'publish.profile-cms-draft',
    path: '/api/profile-cms/agent-session/draft',
    as: PROBE_CALLER
  }
];

/**
 * Profile sites and legacy CMS sites.
 */
export const publishManifest: AreaManifest = {
  area: 'publish',
  flags: {},
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
    profile_cms_chain_heads: { class: 'INDEX', origin: 'planned' }
  },
  seeds: [],
  rebuilders: [],
  probes: PROBES
};
