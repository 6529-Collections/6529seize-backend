import { AreaManifest, Probe, ProbeCaller } from '@/rebuild/manifest.types';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';

/**
 * The second fixture profile. The first one mutes it (the personal seed),
 * and today's writers write no notification from a muted profile, so the
 * notifications are the second profile's, from the first.
 */
export const NOTIFY_PROBE_CALLER: ProbeCaller = { wallet: PROBE_WALLETS[1] };

/**
 * Follow actions are read with no order (a plain select and group_concat),
 * so the same rows can list them in another order on each pass.
 */
const FOLLOW_ACTIONS_UNORDERED =
  'Follow actions are read without an order; the same rows can list them differently.';

const unordered = (paths: readonly string[]) =>
  paths.map((path) => ({ path, reason: FOLLOW_ACTIONS_UNORDERED }));

/** The drops a drop nests in full: its reply's parent and its quoted drops. */
const NESTED_DROPS = ['.reply_to.drop', '.parts[*].quoted_drop.drop'];

/**
 * A v1 notification's related drops and the drops they nest, two levels
 * down. The drop mapper loads only the related drops' parents and quotes,
 * but it fills a nested drop whenever that drop is loaded, so nesting can
 * go deeper when related drops on one page reply to or quote each other in
 * a chain (C replies to B, B to A, A to its parent). The probe fixture has
 * no such chain; a path step that reaches any depth would cover it.
 */
const V1_DROPS = ['$.notifications[*].related_drops[*]'].flatMap((root) => [
  root,
  ...NESTED_DROPS.map((one) => `${root}${one}`),
  ...NESTED_DROPS.flatMap((one) =>
    NESTED_DROPS.map((two) => `${root}${one}${two}`)
  )
]);

/** Where a drop lists follow actions: its own, and those of the profiles in it. */
const DROP_FOLLOW_ACTIONS = [
  '.subscribed_actions',
  '.author.subscribed_actions',
  '.metadata[*].resolved_profile.subscribed_actions',
  '.reactions[*].profiles[*].subscribed_actions',
  '.top_raters[*].profile.subscribed_actions'
];

/** Every place a v1 notifications answer lists follow actions. */
const V1_FOLLOW_ACTIONS = unordered([
  '$.notifications[*].related_identity.subscribed_actions',
  ...V1_DROPS.flatMap((drop) =>
    DROP_FOLLOW_ACTIONS.map((field) => `${drop}${field}`)
  )
]);

/**
 * Every place a v2 notifications answer lists follow actions: a wave's
 * creator, and its parent wave's (filled one level up). v2 lists
 * identities and drops in overview shapes without them.
 */
const V2_FOLLOW_ACTIONS = unordered(
  [
    '$.notifications[*].related_wave',
    '$.notifications[*].related_drops[*].wave'
  ]
    .flatMap((wave) => [wave, `${wave}.parent_wave`])
    .map((wave) => `${wave}.creator.subscribed_actions`)
);

/** A person's notifications, as the second fixture profile. */
const PROBES: Probe[] = [
  {
    id: 'notify.notifications',
    path: '/api/notifications?limit=50',
    as: NOTIFY_PROBE_CALLER,
    unordered: V1_FOLLOW_ACTIONS
  },
  {
    id: 'notify.notifications-v2',
    path: '/api/v2/notifications?limit=50',
    as: NOTIFY_PROBE_CALLER,
    unordered: V2_FOLLOW_ACTIONS
  },
  {
    id: 'notify.unread-count',
    path: '/api/v2/notifications/unread-count',
    as: NOTIFY_PROBE_CALLER
  }
];

/**
 * Notifications, push delivery, sign-in sessions, live updates and bot
 * bookkeeping.
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
    notification_view: { class: 'INDEX' },
    notification_view_cursors: {
      class: 'EPHEMERAL',
      why: "The deriver's cursor per source; a rebuild replays from the start."
    },
    notification_view_push_outbox: {
      class: 'EPHEMERAL',
      why: 'Pushes queued with their view rows; a rebuild queues none.'
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
  // Before the switch: the old writers' rows for the probe caller (a
  // follow, read; a rating, unread). identity_notifications has no
  // rebuilder yet: at the switch its rows move to notification_view as
  // CARRIED rows, whose rebuild reads the sealed archive in the record log.
  seeds: [
    {
      id: 'notify.probe-notifications',
      run: {
        module: 'src/notifications/view/notification-rebuild.seed',
        exportName: 'seedNotifications'
      },
      writes: ['identity_notifications'],
      // The old writers' filters: mutes, blocks, moderation, preferences.
      reads: [
        'identity_mutes',
        'content_moderation_profile_blocks',
        'content_moderation_drop_states',
        'drops',
        'profile_preferences'
      ],
      after: ['identity.probe-profiles'],
      sources: ['repo'],
      timeoutMinutes: 5
    }
  ],
  rebuilders: [],
  probes: PROBES
};
