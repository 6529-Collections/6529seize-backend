/**
 * First-party telemetry wire schema, version 1 (owner decision C52).
 *
 * This module is the single source of truth for what the collector accepts.
 * Anything not listed here is dropped by the sanitizer before it reaches
 * storage: unknown fields, unknown events, unknown property values and
 * malformed values. `telemetry-collector.v1.schema.json` is generated from
 * these constants (see telemetry-json-schema.ts) and published for clients.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_MAX_BATCH_BYTES = 8 * 1024;
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 40;
export const TELEMETRY_MAX_ROUTE_LENGTH = 96;
export const TELEMETRY_MAX_ROUTE_SEGMENTS = 8;
export const TELEMETRY_MAX_REFERRER_LENGTH = 100;
export const TELEMETRY_MAX_COUNT = 10_000;
export const TELEMETRY_MAX_DIMS_PER_COUNTER = 16;
export const TELEMETRY_MAX_PRODUCT_EVENT_PROPS = 6;
export const TELEMETRY_MAX_VITAL_MS = 300_000;
export const TELEMETRY_MAX_CLS = 100;
/** Route and endpoint values that fail validation are folded into this. */
export const TELEMETRY_OTHER_ROUTE = '/[other]';
export const TELEMETRY_ENTRY_ROUTE = 'entry';
export const TELEMETRY_OTHER_PAGE_GROUP = 'other';
/**
 * Optional coarse client hash (C52a). Used only inside the in-memory daily
 * uniques hash and then discarded; never stored or logged.
 */
export const TELEMETRY_FP_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;

export const TELEMETRY_EVENT_TYPES = ['pv', 'vitals', 'ev', 'health'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export const TELEMETRY_DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export type TelemetryDevice = (typeof TELEMETRY_DEVICES)[number];

export const TELEMETRY_PLATFORMS = [
  'web',
  'ios',
  'android',
  'desktop'
] as const;
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number];

export const TELEMETRY_BROWSERS = [
  'chrome',
  'safari',
  'firefox',
  'edge',
  'other'
] as const;
export type TelemetryBrowser = (typeof TELEMETRY_BROWSERS)[number];

export const TELEMETRY_TIME_VITALS = ['lcp', 'inp', 'ttfb', 'fcp'] as const;
export const TELEMETRY_VITAL_METRICS = [
  ...TELEMETRY_TIME_VITALS,
  'cls',
  'ws_lag'
] as const;
export type TelemetryVitalMetric = (typeof TELEMETRY_VITAL_METRICS)[number];

export const TELEMETRY_HEALTH_SCALAR_COUNTERS = [
  'ws_drop',
  'ws_reconnect',
  'long_task'
] as const;
export const TELEMETRY_HEALTH_ENUM_COUNTERS = {
  asset_fail: ['script', 'style', 'font', 'image', 'media', 'other'],
  error: [
    'unhandled_error',
    'unhandled_rejection',
    'chunk_load',
    'boundary',
    'resource',
    'other'
  ]
} as const satisfies Record<string, readonly string[]>;
/** Keys are API endpoint templates such as `/drops/[id]` (no `/api`). */
export const TELEMETRY_HEALTH_ENDPOINT_COUNTERS = [
  'api_fail',
  'api_slow'
] as const;

/**
 * Known first segments of frontend page routes (the frontend `app/` route
 * folders). A route whose first segment is static and not listed here is
 * recorded as `/[other]`, so a handle or other free text can never become a
 * route value even if a client forgets to template it.
 */
export const TELEMETRY_PAGE_ROUTE_ROOTS: ReadonlySet<string> = new Set([
  '6529-gradient',
  'about',
  'accept-connection-sharing',
  'access',
  'artwork-documentation',
  'author',
  'blog',
  'bookmarks',
  'buidl',
  'capital',
  'casabatllo',
  'category',
  'city',
  'collect',
  'consolidation-mapping-tool',
  'content-moderation',
  'content-preferences',
  'delegation',
  'delegation-mapping-tool',
  'discover',
  'dispute-resolution',
  'drop-forge',
  'education',
  'element_category',
  'email-signatures',
  'emma',
  'error',
  'feed',
  'gm-or-die-small-mp4',
  'join',
  'join-6529',
  'meme-accounting',
  'meme-calendar',
  'meme-gas',
  'meme-lab',
  'messages',
  'museum',
  'my-stream',
  'network',
  'news',
  'nextgen',
  'nft-activity',
  'notifications',
  'om',
  'open-data',
  'open-mobile',
  'preferences',
  'rememes',
  'rep',
  'restricted',
  'safe-collecting',
  'slide-page',
  'stream',
  'the-memes',
  'tools',
  'validator',
  'wave-not-found',
  'waves',
  'xtdh'
]);

/** Page groups are the known route roots plus these synthetic groups. */
export const TELEMETRY_EXTRA_PAGE_GROUPS: ReadonlySet<string> = new Set([
  'home',
  'profile',
  TELEMETRY_OTHER_PAGE_GROUP
]);

/** Known first segments of API endpoints under `/api`. */
export const TELEMETRY_API_ROUTE_ROOTS: ReadonlySet<string> = new Set([
  'aggregated-activity',
  'alchemy-proxy',
  'artwork-documentation',
  'attachments',
  'auth',
  'blocks',
  'boosted-drops',
  'bulk-rep',
  'cms',
  'collect',
  'collected-stats',
  'community-members',
  'community-metrics',
  'consolidated_uploads',
  'consolidations',
  'content-moderation',
  'curated-profile-wave-drops',
  'delegations',
  'device-grants',
  'distribution_phases',
  'distribution_photos',
  'distributions',
  'dm-drops',
  'drop-ids',
  'drop-media',
  'drops',
  'drops-bookmarked',
  'e2ee',
  'feed',
  'gas',
  'groups',
  'groups_im_eligible_for',
  'identities',
  'identity-subscriptions',
  'light-drops',
  'market',
  'market-depth',
  'media',
  'meme-cards',
  'memelab',
  'memes',
  'memes-mint-stats',
  'memes_extended_data',
  'mention-aliases',
  'minting-claims',
  'nextgen',
  'nft-activity',
  'nft-link',
  'nft-owners',
  'nft_history',
  'nfts',
  'nfts_memelab',
  'notifications',
  'og-metadata',
  'owners-balances',
  'policies',
  'profile-cms',
  'profile-logs',
  'profile-preferences',
  'profile-subclassifications',
  'profiles',
  'proxies',
  'public',
  'push-notifications',
  'ratings',
  'rememes',
  'rep',
  'royalties',
  'settings',
  'subscriptions',
  'tdh',
  'tdh-editions',
  'transactions',
  'uploads',
  'v2',
  'v3',
  'wave',
  'wave-group-validation',
  'wave-media',
  'waves',
  'waves-overview',
  'xtdh'
]);

const HOMEPAGE_SECTIONS = [
  'Introduction',
  'Get started',
  'How to start',
  'Latest drop',
  'Next drop',
  'About 6529',
  'Coming up',
  'Boosted drops',
  'Explore waves'
] as const;

const HOMEPAGE_ACTIONS = [
  'Open network health',
  'Get started',
  'Connect wallet',
  'Browse Waves',
  'Create profile',
  'View collections',
  'Open artwork',
  'Open artist profile',
  'Toggle edition details',
  'View distribution plan',
  'Mint',
  'Manage subscriptions',
  'About subscriptions',
  'About submissions',
  'View all',
  'Open drop',
  'Open wave'
] as const;

const PROFILE_SECTIONS = [
  'Collection summary',
  'Collection details',
  'Filters',
  'Artwork'
] as const;

const PROFILE_ACTIONS = [
  'Details',
  'Hide details',
  'Complete my set',
  'Manage orders',
  'Open artwork',
  'Change view',
  'Change collection',
  'Change season',
  'Change sort',
  'Change seized filter',
  'Clear filters',
  'Change address',
  'Change page',
  'Show more seasons',
  'Show fewer seasons'
] as const;

const AUTH_CLIENT_TYPES = ['desktop', 'native', 'web'] as const;
const AUTH_REASONS = [
  'auth_validation_failed',
  'session_refresh',
  'session_upgrade_deadline_expired',
  'session_upgrade_required',
  'stored_auth_invalid',
  'wallet_not_authorized'
] as const;
const AUTH_REFRESH_OUTCOMES = [
  'cancelled',
  'empty',
  'failed',
  'local_valid_after_failure',
  'missing_wallet',
  'not_attempted',
  'success'
] as const;
const AUTH_STATES = [
  'authenticated',
  'auth_validation_failed',
  'logged_out',
  'reauth_prompt',
  'refresh_needed',
  'session_upgrade_prompt',
  'session_upgrade_required',
  'wallet_connected'
] as const;
const AUTH_IMPACT_OUTCOMES = [
  'failed_without_prompt',
  'logout_required',
  'reauth_required',
  'session_upgrade_required'
] as const;

const WAVE_FEED_LOAD_SOURCES = [
  'background_sync',
  'cache',
  'initial_visible',
  'native_initial_backfill',
  'server_initial'
] as const;
const WAVE_FEED_STATUS_BUCKETS = [
  'aborted',
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'network_error',
  'unknown'
] as const;
const WAVE_FEED_ERROR_KINDS = [
  'abort',
  'auth',
  'client',
  'network',
  'rate_limit',
  'server',
  'unknown'
] as const;
const DURATION_BUCKETS = ['under_1s', '1s_3s', '3s_10s', 'over_10s'] as const;
const DROP_COUNT_BUCKETS = ['0', '1-9', '10-49', '50+'] as const;

/**
 * Every Wave feature value is a fixed UI enum (section, tab and sort kinds).
 * None of them can carry a wave, drop or profile id or a user-written name.
 */
const WAVE_FEATURES = [
  'sidebar_section',
  'sidebar_entry',
  'sidebar_collection',
  'wave_tab',
  'leaderboard_sort'
] as const;
const WAVE_FEATURE_VALUES = [
  'recommendations',
  'active_votes',
  'recommendations_all',
  'recommendations_wave',
  'active_votes_all',
  'active_votes_wave',
  'profile_feed',
  'search',
  'all',
  'pinned',
  'joined',
  'chat',
  'competitions',
  'leaderboard',
  'submissions',
  'sales',
  'winners',
  'outcome',
  'my_votes',
  'polls',
  'faq',
  'configuration',
  'about',
  'voters',
  'rank',
  'rating_prediction',
  'realtime_vote',
  'trend',
  'created_at',
  'price',
  'menu'
] as const;
const WAVE_FEATURE_PLACEMENTS = [
  'sidebar',
  'wave_tabs',
  'leaderboard_tabs',
  'leaderboard_dropdown'
] as const;
const WAVE_FEATURE_VIEWERS = ['guest', 'profile', 'proxy'] as const;

/** A string prop lists its allowed values; `true` marks a boolean prop. */
export type TelemetryPropSpec = readonly string[] | true;
export type TelemetryProductEventSpec = Readonly<
  Record<string, TelemetryPropSpec>
>;

const homepageBase = {
  section: HOMEPAGE_SECTIONS,
  signed_in: true,
  is_native: true,
  screen_size: ['Small', 'Medium', 'Large'],
  layout_version: ['1']
} as const;

const profileBase = {
  section: PROFILE_SECTIONS,
  profile_viewer_context: ['self', 'other', 'anonymous'],
  profile_tab: ['Collected'],
  client: ['native', 'desktop_app', 'mobile_web', 'desktop_web']
} as const;

const authImpact = {
  client_type: AUTH_CLIENT_TYPES,
  reason: AUTH_REASONS,
  refresh_outcome: AUTH_REFRESH_OUTCOMES,
  auth_state_after: AUTH_STATES,
  product_failure: true,
  was_connected_wallet: true
} as const;

const authRefresh = {
  client_type: AUTH_CLIENT_TYPES,
  had_local_jwt: true,
  refresh_outcome: AUTH_REFRESH_OUTCOMES,
  product_failure: true
} as const;

const waveFeedBase = {
  load_source: WAVE_FEED_LOAD_SOURCES,
  duration_bucket: DURATION_BUCKETS,
  had_cached_drops: true,
  is_native: true
} as const;

const waveFeatureBase = {
  feature: WAVE_FEATURES,
  value: WAVE_FEATURE_VALUES,
  placement: WAVE_FEATURE_PLACEMENTS,
  viewer: WAVE_FEATURE_VIEWERS
} as const;

/**
 * Product events seeded from the four Mixpanel reports (C52 D5): Homepage,
 * Profile (Collected), Product Impact (auth and Waves feed) and the Wave
 * feature pilot. Each event allows at most six enum or boolean props.
 */
export const TELEMETRY_PRODUCT_EVENTS: Readonly<
  Record<string, TelemetryProductEventSpec>
> = {
  'Homepage section seen': homepageBase,
  'Homepage action clicked': { ...homepageBase, action: HOMEPAGE_ACTIONS },
  'Profile section seen': profileBase,
  'Profile action clicked': { ...profileBase, action: PROFILE_ACTIONS },
  'Auth Forced Logout': authImpact,
  'Auth Reauth Prompt Shown': authImpact,
  'Auth Session Refresh Recovered': authImpact,
  'Auth Session Upgrade Prompt Shown': authImpact,
  'Auth Validation Failed While Connected': authImpact,
  'Auth Session Refresh Succeeded': authRefresh,
  'Auth Validation Cancelled': authRefresh,
  'Auth Session Refresh Product Impact': {
    client_type: AUTH_CLIENT_TYPES,
    had_local_jwt: true,
    outcome: AUTH_IMPACT_OUTCOMES,
    refresh_outcome: AUTH_REFRESH_OUTCOMES,
    product_failure: true,
    reauth_required: true
  },
  'Wave Feed Load Started': waveFeedBase,
  'Wave Feed Load Succeeded': {
    ...waveFeedBase,
    drop_count_bucket: DROP_COUNT_BUCKETS
  },
  'Wave Feed Load Cancelled': waveFeedBase,
  'Wave Feed Load Failed': {
    load_source: WAVE_FEED_LOAD_SOURCES,
    duration_bucket: DURATION_BUCKETS,
    status_bucket: WAVE_FEED_STATUS_BUCKETS,
    error_kind: WAVE_FEED_ERROR_KINDS,
    product_failure: true,
    is_native: true
  },
  'Wave Feature Seen': {
    ...waveFeatureBase,
    selection_source: ['user', 'automatic'],
    exposure_kind: ['foreground_dwell', 'direct_activation']
  },
  'Wave Feature Activated': {
    ...waveFeatureBase,
    selected: true,
    action: ['choose', 'open', 'expand', 'collapse']
  }
};
