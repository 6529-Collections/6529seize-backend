import { createHash } from 'node:crypto';
import { AreaManifest, Probe, RebuildStep } from '@/rebuild/manifest.types';
import { PROBE_CALLER, PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';

/** A fake wave, drop and device id the seed uses for its rows. */
const PROBE_WAVE = '00000000-0000-4000-8000-000000000001';
const PROBE_DROP = '00000000-0000-4000-8000-000000000002';
const PROBE_DEVICE = 'rebuild-check-settings-device';

/**
 * The records service identity of a rebuild run: a fake wave, profile and
 * wallet, and a provider key made only for the rebuild check, derived from
 * a public label so it can never be mistaken for a real one.
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

// The follow lists read actions with group_concat, one target with a plain
// select: neither has an ORDER BY, live or after a rebuild.
const FOLLOW_ACTIONS_UNORDERED =
  "A follow's actions are a set, read with no ORDER BY: MySQL's plan decides their order.";

/** Every GET route that reads a personal settings or Collect plans table. */
const PROBES: Probe[] = [
  {
    id: 'personal.follows-out',
    path: '/api/identity-subscriptions/outgoing/{type}',
    each: { type: ['IDENTITY', 'WAVE', 'DROP'] },
    as: PROBE_CALLER,
    unordered: [{ path: '$.data[*].actions', reason: FOLLOW_ACTIONS_UNORDERED }]
  },
  {
    id: 'personal.follows-in',
    path: '/api/identity-subscriptions/incoming/IDENTITY/{wallet}',
    each: { wallet: PROBE_WALLETS },
    unordered: [{ path: '$.data[*].actions', reason: FOLLOW_ACTIONS_UNORDERED }]
  },
  {
    id: 'personal.identity-subscriptions',
    path: '/api/identities/{wallet}/subscriptions',
    // The caller's own profile has no follow of itself to show.
    each: { wallet: [PROBE_WALLETS[1]] },
    as: PROBE_CALLER,
    unordered: [{ path: '$.actions', reason: FOLLOW_ACTIONS_UNORDERED }]
  },
  {
    id: 'personal.mute',
    path: '/api/identities/{wallet}/mute',
    // The seed mutes the records service, not the other probe profile.
    each: { wallet: [FIXTURE_RECORDS_FLAGS.SIGNED_RECORDS_SERVICE_WALLET] },
    as: PROBE_CALLER
  },
  {
    id: 'personal.artwork-alerts',
    path: '/api/identities/{wallet}/artwork-alerts',
    // Artwork alerts for one's own profile are refused.
    each: { wallet: [PROBE_WALLETS[1]] },
    as: PROBE_CALLER
  },
  {
    id: 'personal.preferences',
    path: '/api/profile-preferences',
    as: PROBE_CALLER
  },
  {
    id: 'personal.mention-aliases',
    path: '/api/mention-aliases',
    as: PROBE_CALLER
  },
  {
    id: 'personal.pinned-waves',
    path: '/api/v2/waves/pinned',
    as: PROBE_CALLER
  },
  { id: 'personal.bookmarks', path: '/api/drops-bookmarked', as: PROBE_CALLER },
  {
    id: 'personal.bookmarks-status',
    path: `/api/drops-bookmarked/status?drop_id=${PROBE_DROP}`,
    as: PROBE_CALLER
  },
  {
    id: 'personal.wave-notify',
    path: `/api/notifications/wave-subscription/${PROBE_WAVE}`,
    as: PROBE_CALLER
  },
  {
    id: 'personal.blocked-profiles',
    path: '/api/content-moderation/blocked-profiles',
    as: PROBE_CALLER
  },
  {
    id: 'personal.push-settings',
    path: `/api/push-notifications/settings/${PROBE_DEVICE}`,
    as: PROBE_CALLER
  },
  {
    id: 'personal.eula-consent',
    path: `/api/policies/eula-consent/${PROBE_DEVICE}`,
    as: PROBE_CALLER
  },
  { id: 'personal.collect-rules', path: '/api/collect/rules', as: PROBE_CALLER }
];

/**
 * The personal settings tables rebuildPersonalTables writes
 * (personal-rebuild.step.ts): the settings, the record heads, the segment
 * table and the switch state.
 */
const PERSONAL_SETTINGS_REBUILD: RebuildStep = {
  id: 'personal.settings',
  run: {
    module: 'src/personal-records/personal-rebuild.step',
    exportName: 'rebuildPersonalTables'
  },
  writes: [
    'identity_subscriptions',
    'wave_group_notification_subscriptions',
    'identity_mutes',
    'content_moderation_profile_blocks',
    'content_moderation_hidden_drops',
    'drop_bookmarks',
    'artist_artwork_alerts',
    'pinned_waves',
    'profile_preferences',
    'mention_aliases',
    'mention_alias_members',
    'push_notification_settings',
    'eula_consent',
    'signed_record_heads',
    'signed_record_log_segments',
    'personal_records_state'
  ],
  // The records wave's drops and the waves index (the waves rebuild's),
  // and the profiles and identities owners map to.
  reads: [
    'drops',
    'drops_parts',
    'waves',
    // Today's reads of waves and drops go through the competition
    // facade's views (legacy-competition-get-facade.ts), which also read
    // the competition tables they join.
    'legacy_get_waves',
    'legacy_get_drops',
    'competitions',
    'competition_entries',
    'profiles',
    'identities',
    'address_consolidation_keys'
  ],
  sources: ['gateway', 'files', 'ethereum'],
  timeoutMinutes: 60
};

/**
 * The probe caller's settings, written as today's routes write them, then
 * the switch: the import into the record log, a closed segment in the
 * run's seed files and its head drop in the records wave
 * (src/rebuild/areas/personal.seed.ts). The rebuild takes every row back
 * from there.
 */
const PERSONAL_SETTINGS_SEED: RebuildStep = {
  id: 'personal.seed',
  run: {
    module: 'src/rebuild/areas/personal.seed',
    exportName: 'seedPersonalSettings'
  },
  writes: [
    ...PERSONAL_SETTINGS_REBUILD.writes,
    'signed_record_log_entries',
    'waves',
    'drops',
    'drops_parts',
    'identities',
    'address_consolidation_keys',
    'profiles'
  ],
  reads: [
    'legacy_get_waves',
    'legacy_get_drops',
    'competitions',
    'competition_entries'
  ],
  after: ['identity.probe-profiles'],
  sources: ['files'],
  timeoutMinutes: 20
};

/**
 * Personal settings and Collect plans.
 *
 * The personal settings tables are rebuilt from the one-time import at the
 * switch (the record log's `personal-import` entries) and the people's
 * signed records (its `personal` events): follows of people from public
 * `ps` records, every other setting (follows of waves and drops too) from
 * provider-class sealed items in `pv`, opened with 6529.io's provider key
 * (src/personal-records/personal-import.ts, rebuildPersonalState).
 * Derived on rebuild, not from records: an author's auto-follow and a
 * creator's default wave-notify rows (from the waves index), and a block
 * or hide set through a drop report (from the report records, which keep
 * the reporter and the hide flag).
 * The audit rows of people's own blocks and hides belong to the audit
 * log's rebuild, which takes them from personalModerationAuditRows
 * (personal-moderation-audit.ts).
 */
export const personalManifest: AreaManifest = {
  area: 'personal',
  flags: {
    PERSONAL_RECORDS_MODE: 'primary',
    FEATURE_SIGNED_RECORD_LOG: 'true',
    ...FIXTURE_RECORDS_FLAGS
  },
  tables: {
    collect_plans: { class: 'INDEX' },
    collect_rule_operations: { class: 'INDEX' },
    collect_rules: { class: 'INDEX' },
    market_operation_events: {
      class: 'EPHEMERAL',
      why: 'Journal of orders in flight; a settled order is its Ethereum receipt.'
    },
    market_operations: {
      class: 'EPHEMERAL',
      why: 'Journal of orders in flight; a settled order is its Ethereum receipt.'
    },
    market_reviewed_transactions: {
      class: 'EPHEMERAL',
      why: 'Journal of orders in flight; a settled order is its Ethereum receipt.'
    },
    market_wallet_exposure_locks: {
      class: 'EPHEMERAL',
      why: 'Locks on orders in flight.'
    },
    artist_artwork_alerts: { class: 'INDEX' },
    content_moderation_hidden_drops: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'id', reason: 'Generated row id; the API never returns it.' }
      ]
    },
    content_moderation_profile_blocks: {
      class: 'INDEX',
      volatileColumns: [
        { column: 'id', reason: 'Generated row id; the API never returns it.' }
      ]
    },
    cookies_consent: {
      class: 'EPHEMERAL',
      why: "The browser's cookie is the record."
    },
    drop_bookmarks: { class: 'INDEX' },
    drop_quickvote_skips: {
      class: 'EPHEMERAL',
      why: 'A per-person cursor through the quick-vote queue. If lost, quick vote shows a few drops again.'
    },
    eula_consent: { class: 'INDEX' },
    identity_mutes: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'id',
          reason: 'Auto-increment row id; the API never returns it.'
        }
      ]
    },
    identity_subscriptions: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'id',
          reason: 'Auto-increment row id; the API never returns it.'
        }
      ]
    },
    mention_alias_members: { class: 'INDEX' },
    mention_aliases: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: 'Row housekeeping; the API never returns it.'
        },
        {
          column: 'updated_at',
          reason: 'Row housekeeping; the API never returns it.'
        }
      ]
    },
    pinned_waves: { class: 'INDEX' },
    profile_preferences: { class: 'INDEX' },
    push_notification_settings: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: 'Row housekeeping; the API never returns it.'
        },
        {
          column: 'updated_at',
          reason: 'Row housekeeping; the API never returns it.'
        }
      ]
    },
    wave_group_notification_subscriptions: { class: 'INDEX' },
    // The switch state: the rebuild writes it with settings open (not
    // frozen) and the latest import's order key, from the import's closing
    // entry in the log (restorePersonalSwitchState).
    personal_records_state: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'updated_at',
          reason: 'Row housekeeping; the API never returns it.'
        }
      ]
    },
    signed_record_heads: { class: 'INDEX' },
    signed_record_log_entries: {
      class: 'EPHEMERAL',
      why: 'The record log queue: entries leave it once their segment is posted.'
    },
    signed_record_log_segments: {
      class: 'INDEX',
      // A segment restored from the records wave keeps its head, not its
      // file or its open and close times: the file is on IPFS and Arweave.
      volatileColumns: [
        {
          column: 'content',
          reason:
            'A restored segment keeps no copy of its file; the file is on IPFS and Arweave, and the archiver reads it back from there.'
        },
        {
          column: 'opened_at',
          reason:
            'A restored segment has no open time: the head drop does not carry it. No route returns it.'
        },
        {
          column: 'closed_at',
          reason:
            'A restored segment has no close time: the head drop does not carry it. No route returns it.'
        }
      ]
    }
  },
  seeds: [PERSONAL_SETTINGS_SEED],
  rebuilders: [PERSONAL_SETTINGS_REBUILD],
  probes: PROBES,
  waivers: {
    routes: [
      {
        target: 'GET /api/signed-records/owners',
        reason:
          "Answers 503 OWNERS_UNAVAILABLE until the chain gateway client is wired in (wireSignedRecordsChain); nothing in the API wires it yet. It becomes a probe of the probe wallets' owners in the PR that wires it."
      },
      {
        target: 'GET /api/signed-records/anchor',
        reason:
          'Answers 503 ANCHOR_UNAVAILABLE until the chain gateway client is wired in (wireSignedRecordsChain); nothing in the API wires it yet. It becomes a probe in the PR that wires it, against the gateway recording.'
      }
    ]
  }
};
