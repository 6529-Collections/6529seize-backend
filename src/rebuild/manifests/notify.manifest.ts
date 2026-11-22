import { AreaManifest, Probe } from '@/rebuild/manifest.types';
import { PROBE_CALLER } from '@/rebuild/manifests/probe-fixture';

/** A person's notifications, as the probe fixture's caller. */
const PROBES: Probe[] = [
  {
    id: 'notify.notifications',
    path: '/api/notifications?limit=50',
    as: PROBE_CALLER
  },
  {
    id: 'notify.notifications-v2',
    path: '/api/v2/notifications?limit=50',
    as: PROBE_CALLER
  },
  {
    id: 'notify.unread-count',
    path: '/api/v2/notifications/unread-count',
    as: PROBE_CALLER
  }
];

/**
 * Notifications, push delivery, sign-in sessions, live updates and bot
 * bookkeeping.
 * Classes start from the migration map; the area confirms or changes each one.
 */
export const notifyManifest: AreaManifest = {
  area: 'notify',
  flags: {},
  tables: {
    refresh_tokens: {
      class: 'EPHEMERAL',
      why: 'Sign-in sessions; people sign in again.'
    },
    wallet_auth_sessions: {
      class: 'EPHEMERAL',
      why: 'Sign-in sessions; people sign in again.'
    },
    wallet_connection_shares: {
      class: 'EPHEMERAL',
      why: 'Sign-in hand-offs; people sign in again.'
    },
    ws_connections: {
      class: 'EPHEMERAL',
      why: 'Live WebSocket connections.'
    },
    ws_notification_subscriptions: {
      class: 'EPHEMERAL',
      why: 'Live WebSocket subscriptions.'
    },
    help_bot_interactions: { class: 'INDEX' },
    release_digest_entries: { class: 'INDEX' },
    release_digests: { class: 'INDEX' },
    release_note_publications: { class: 'INDEX' },
    release_note_recovery_jobs: {
      class: 'EPHEMERAL',
      why: 'Bot job queue.'
    },
    release_note_stream_states: {
      class: 'EPHEMERAL',
      why: 'Bot stream cursor.'
    },
    identity_notifications: { class: 'INDEX' },
    // The notifications view: derived from the indexes and personal
    // records, or carried from a sealed archive.
    notification_view: { class: 'INDEX', origin: 'planned' },
    notification_view_cursors: {
      class: 'EPHEMERAL',
      why: "The deriver's cursor per source; a rebuild replays from the start.",
      origin: 'planned'
    },
    notification_view_push_outbox: {
      class: 'EPHEMERAL',
      why: 'Pushes queued with their view rows; a rebuild queues none.',
      origin: 'planned'
    },
    push_notification_cancellations: {
      class: 'EPHEMERAL',
      why: 'Pending push cancellations; they expire.'
    },
    push_notification_outbox_entries: {
      class: 'EPHEMERAL',
      why: 'Push outbox.'
    },
    voting_credit_release_recipients: { class: 'INDEX' },
    voting_credit_releases: { class: 'INDEX' },
    push_notification_device_installations: {
      class: 'EPHEMERAL',
      why: 'Push device registrations; apps register again at start.'
    },
    push_notification_device_logout_fences: {
      class: 'EPHEMERAL',
      why: 'Push device logout fences; apps register again at start.'
    },
    push_notification_devices: {
      class: 'EPHEMERAL',
      why: 'Push device registrations; apps register again at start.'
    }
  },
  seeds: [],
  rebuilders: [],
  probes: PROBES
};
