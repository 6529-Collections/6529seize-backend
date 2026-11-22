import { AreaManifest } from '@/rebuild/manifest.types';

/**
 * Personal settings and Collect plans.
 * Classes start from the migration map; the area confirms or changes each one.
 */
export const personalManifest: AreaManifest = {
  area: 'personal',
  flags: {},
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
    content_moderation_hidden_drops: { class: 'INDEX' },
    content_moderation_profile_blocks: { class: 'INDEX' },
    cookies_consent: {
      class: 'EPHEMERAL',
      why: "The browser's cookie is the record."
    },
    drop_bookmarks: {
      class: 'PROVIDER',
      why: '6529.io keeps these for each person as a service.'
    },
    drop_quickvote_skips: {
      class: 'PROVIDER',
      why: '6529.io keeps these for each person as a service.'
    },
    eula_consent: { class: 'INDEX' },
    identity_mutes: { class: 'INDEX' },
    identity_subscriptions: { class: 'INDEX' },
    mention_alias_members: {
      class: 'PROVIDER',
      why: '6529.io keeps these for each person as a service.'
    },
    mention_aliases: {
      class: 'PROVIDER',
      why: '6529.io keeps these for each person as a service.'
    },
    pinned_waves: {
      class: 'PROVIDER',
      why: '6529.io keeps these for each person as a service.'
    },
    profile_preferences: { class: 'INDEX' },
    push_notification_settings: { class: 'INDEX' },
    wave_group_notification_subscriptions: { class: 'INDEX' },
    signed_record_heads: { class: 'INDEX', origin: 'planned' },
    signed_record_log_entries: { class: 'INDEX', origin: 'planned' },
    signed_record_log_segments: { class: 'INDEX', origin: 'planned' }
  },
  seeds: [],
  rebuilders: [],
  probes: []
};
