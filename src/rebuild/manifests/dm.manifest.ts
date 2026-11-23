import {
  E2EE_CHECK_IDS,
  E2EE_CHECK_KEYS,
  E2EE_CHECK_PROFILES
} from '@/rebuild/steps/e2ee-relay.fixture';
import { AreaManifest, Probe } from '@/rebuild/manifest.types';

const STEPS = 'src/rebuild/steps/e2ee-relay.steps';
const RELAY_CHECK = 'src/e2ee/relay/e2ee-relay-check';

/**
 * The tables the relay records carry (the delivery service's, and the
 * reports in the moderators' inbox), and the stream heads.
 */
const RECORD_TABLES = [
  'content_moderation_items',
  'content_moderation_reports',
  'e2ee_report_access_log',
  'e2ee_reports',
  'e2ee_backup_chunks',
  'e2ee_backups',
  'e2ee_blob_chunks',
  'e2ee_blobs',
  'e2ee_ciphertext_objects',
  'e2ee_devices',
  'e2ee_group_epochs',
  'e2ee_group_roster',
  'e2ee_groups',
  'e2ee_key_packages',
  'e2ee_log',
  'e2ee_welcome_deliveries',
  'e2ee_welcomes',
  'e2ee_streams',
  'e2ee_record_items'
];

/** The grant wallets of the orderer and the site reader below. */
const ORDERER_WALLET = `0x${'aa'.repeat(20)}`;
const READER_WALLET = `0x${'bb'.repeat(20)}`;
/**
 * Test identities for the relay records: seeds 0x07 and 0x09, grants with
 * placeholder signatures (the relay settings don't verify them), and the
 * moderation key from seed 0x31, as the relay tests use.
 */
const ORDERER_GRANT = JSON.stringify({
  id: '0xc654c8aface3000b08f3f2809322ba19d927a493a0d803e471f9f1b24bed4cf1',
  message: 'test grant',
  wallet_signature: `0x${'11'.repeat(65)}`,
  chain_id: 1,
  wallet: ORDERER_WALLET,
  device_key:
    '0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
  scopes: ['post'],
  domain: '6529 Network P2P',
  expires_at: 4102444800000,
  revoked_at: null
});
const READER_GRANT = JSON.stringify({
  id: '0xf8ec0d08b9513bc670dc61c3cfefad9f5e57b5a10b7d94bf6a9a9088b65e9e92',
  message: 'test grant',
  wallet_signature: `0x${'11'.repeat(65)}`,
  chain_id: 1,
  wallet: READER_WALLET,
  device_key:
    '0xfd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618',
  scopes: ['post'],
  domain: '6529 Network P2P',
  expires_at: 4102444800000,
  revoked_at: null
});

const A = E2EE_CHECK_KEYS.a.publicKey;
const B = E2EE_CHECK_KEYS.b.publicKey;
const C = E2EE_CHECK_KEYS.c.publicKey;
const AS_A = { wallet: E2EE_CHECK_PROFILES.a.wallet };
const AS_B = { wallet: E2EE_CHECK_PROFILES.b.wallet };
const ACTIVITY = {
  reason: 'Activity: the rebuild derives it from the log, and calls move it.'
};

/**
 * The answers a person's devices read, as the fixture's members a and b
 * (the dm tests' `answers()` as routes).
 */
const PROBES: Probe[] = [
  {
    id: 'dm.e2ee.me',
    path: '/api/e2ee/me',
    as: AS_A,
    ignore: [{ path: '$.devices[*].last_seen_at', ...ACTIVITY }]
  },
  {
    id: 'dm.e2ee.me-b',
    path: '/api/e2ee/me',
    as: AS_B,
    ignore: [{ path: '$.devices[*].last_seen_at', ...ACTIVITY }]
  },
  {
    id: 'dm.e2ee.profile-devices',
    // The fixture devices use suite 0x004E; the route lists 0x004F unless asked.
    path: '/api/e2ee/profiles/{profile}/devices?ciphersuite=78',
    each: {
      profile: [
        E2EE_CHECK_PROFILES.a.profileId,
        E2EE_CHECK_PROFILES.b.profileId
      ]
    },
    as: AS_A,
    ignore: [{ path: '$[*].last_seen_at', ...ACTIVITY }]
  },
  {
    id: 'dm.e2ee.device',
    path: '/api/e2ee/devices/{device}',
    each: { device: [A, B, C] },
    as: AS_A,
    ignore: [{ path: '$.last_seen_at', ...ACTIVITY }]
  },
  {
    id: 'dm.e2ee.device-groups',
    path: `/api/e2ee/devices/${A}/groups`,
    as: AS_A
  },
  {
    id: 'dm.e2ee.inbox-status',
    path: `/api/e2ee/devices/${B}/inbox-status`,
    as: AS_B
  },
  {
    id: 'dm.e2ee.welcomes',
    path: `/api/e2ee/devices/${B}/welcomes`,
    as: AS_B
  },
  {
    id: 'dm.e2ee.group-a',
    path: `/api/e2ee/groups/${E2EE_CHECK_IDS.group}?device_key=${A}`,
    as: AS_A
  },
  {
    id: 'dm.e2ee.group-b',
    path: `/api/e2ee/groups/${E2EE_CHECK_IDS.group}?device_key=${B}`,
    as: AS_B
  },
  {
    id: 'dm.e2ee.log-a',
    path: `/api/e2ee/groups/${E2EE_CHECK_IDS.group}/log?device_key=${A}`,
    as: AS_A
  },
  {
    id: 'dm.e2ee.log-b',
    path: `/api/e2ee/groups/${E2EE_CHECK_IDS.group}/log?device_key=${B}`,
    as: AS_B
  },
  {
    id: 'dm.e2ee.blob-chunk',
    path: `/api/e2ee/blobs/${E2EE_CHECK_IDS.blob}/chunks/{index}?device_key=${B}`,
    each: { index: ['0', '1'] },
    as: AS_B
  },
  { id: 'dm.e2ee.backup-status', path: '/api/e2ee/backup', as: AS_A },
  {
    id: 'dm.e2ee.backup',
    path: `/api/e2ee/backups/${E2EE_CHECK_IDS.backup}`,
    as: AS_A
  },
  {
    id: 'dm.e2ee.backup-chunks',
    path: `/api/e2ee/backups/${E2EE_CHECK_IDS.backup}/chunks`,
    as: AS_A
  },
  {
    id: 'dm.e2ee.backup-chunk',
    path: `/api/e2ee/backups/${E2EE_CHECK_IDS.backup}/chunks/2`,
    as: AS_A
  }
];

/**
 * Encrypted direct messages and reports to moderators.
 * Classes start from the migration map; this manifest confirms or changes
 * each one.
 */
export const dmManifest: AreaManifest = {
  area: 'dm',
  flags: {
    E2EE_DMS_ENABLED: 'true',
    E2EE_BACKUPS_ENABLED: 'true',
    E2EE_RELAY_MODE: 'mirror',
    E2EE_RELAY_URLS: '{relays}',
    E2EE_RELAY_NET: '6529-rebuild-check',
    E2EE_ORDERER_KEY: '07'.repeat(32),
    E2EE_ORDERER_GRANT: ORDERER_GRANT,
    E2EE_ORDERER_PUBLIC_KEY:
      '0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
    E2EE_SITE_READER_KEY: '09'.repeat(32),
    E2EE_SITE_READER_GRANT: READER_GRANT,
    E2EE_MODERATION_PUBLIC_KEY: JSON.stringify({
      id: 'mod-test',
      public_key:
        '0x04f5f29162c31a8defa18e6e742224ee806fc1718a278be859ba5620402b8f3a'
    }),
    E2EE_MODERATION_KEYS: JSON.stringify([
      { id: 'mod-test', private_key: `0x${'31'.repeat(32)}` }
    ])
  },
  tables: {
    e2ee_backup_chunks: { class: 'INDEX' },
    e2ee_backups: { class: 'INDEX' },
    e2ee_blob_chunks: { class: 'INDEX' },
    e2ee_blobs: { class: 'INDEX' },
    e2ee_ciphertext_objects: { class: 'INDEX' },
    e2ee_devices: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'last_seen_at',
          reason: 'Activity: the rebuild derives it from the log.'
        }
      ]
    },
    e2ee_group_epochs: { class: 'INDEX' },
    e2ee_group_roster: { class: 'INDEX' },
    e2ee_groups: { class: 'INDEX' },
    // Last-resort rows come back from the records; one-time rows are refilled
    // by devices (the dm design).
    e2ee_key_packages: { class: 'INDEX' },
    e2ee_log: { class: 'INDEX' },
    e2ee_push_throttle: { class: 'EPHEMERAL', why: 'Rate state.' },
    e2ee_rate_counters: { class: 'EPHEMERAL', why: 'Rate state.' },
    e2ee_welcome_deliveries: { class: 'INDEX' },
    e2ee_welcomes: { class: 'INDEX' },
    abusiveness_detection_results: {
      class: 'PROVIDER',
      why: "A cache of the AI provider's verdicts on REP category text, keyed by the text; asked again on a miss."
    },
    content_moderation_evaluations: {
      class: 'EPHEMERAL',
      why: 'Automated check results; checks run again on demand.'
    },
    content_moderation_items: {
      class: 'INDEX',
      why: "The rebuilder restores each item a moderator acted on (an override, a permit, a suppression, a report's item and its review status) from the moderators' inbox (md), where each decision is a RECORD keyed by the item id. It leaves the AI result (evidence, outcome, trigger, evidence_expires_at, version, updated_at) to a rerun: rebuilt items read PENDING. Items no moderator acted on are AI results only and are not restored. This holds until moderation decisions get records of their own.",
      volatileColumns: [
        'evidence',
        'outcome',
        'trigger',
        'evidence_expires_at',
        'version',
        'updated_at'
      ].map((column) => ({
        column,
        reason: 'The AI result: rerun on demand, not rebuilt.'
      }))
    },
    content_moderation_pre_publication_checks: {
      class: 'EPHEMERAL',
      why: 'The duplicate fingerprint and the hourly budget of pre-publication checks, pruned at 30 days.'
    },
    // Reports and their access log: the moderators' inbox (md), sealed to
    // the moderation service key. Only reports whose drop is known to be in
    // a public wave (live or deleted) are recorded; reports on legacy DMs,
    // or on drops or waves that cannot be found, never are.
    content_moderation_reports: { class: 'INDEX' },
    e2ee_report_access_log: { class: 'INDEX' },
    e2ee_reports: { class: 'INDEX' },
    e2ee_streams: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: 'When the index row was written; no route shows it.'
        },
        {
          column: 'updated_at',
          reason: 'When the index row was written; no route shows it.'
        }
      ]
    },
    e2ee_relay_outbox: {
      class: 'EPHEMERAL',
      why: 'Records not yet on every relay; a row goes once every relay holds it.'
    },
    // Which records carry an item MySQL may delete (the DEL index): the
    // rebuild refills it from the records' own operations.
    e2ee_record_items: {
      class: 'INDEX',
      volatileColumns: [
        {
          column: 'created_at',
          reason: 'When the index row was written; no route shows it.'
        }
      ]
    },
    e2ee_relay_deletions: {
      class: 'EPHEMERAL',
      why: 'DELs not yet on every relay; a row goes once every relay holds it.'
    }
  },
  seeds: [
    {
      id: 'dm.e2ee.seed',
      run: { module: STEPS, exportName: 'seedE2ee' },
      writes: [
        ...RECORD_TABLES,
        'e2ee_relay_outbox',
        'e2ee_relay_deletions',
        // The report path's own audit row (a moderation table).
        'content_moderation_audit_log',
        // The fixture profiles the probes sign in as (identity tables).
        'identities',
        'address_consolidation_keys',
        // A public wave and drop the reports name (waves tables), with the
        // rows production's wave and drop creation write next to them.
        'waves',
        'drops',
        'wave_metrics',
        'wave_dropper_metrics',
        'identity_subscriptions',
        'wave_group_notification_subscriptions'
      ],
      sources: ['relays'],
      timeoutMinutes: 10
    }
  ],
  rebuilders: [
    {
      id: 'dm.e2ee.relay-rebuild',
      run: { module: STEPS, exportName: 'rebuildE2ee' },
      writes: RECORD_TABLES,
      sources: ['relays'],
      timeoutMinutes: 15
    }
  ],
  // Every event of the six families must pass the rebuild's own check
  // (the orderer's pinned key) for a relay recording to count.
  relayChecks: [
    {
      waves: ['cv/', 'dv/', 'dr/', 'bl/', 'bk/', 'md/'],
      run: { module: RELAY_CHECK, exportName: 'checkE2eeRelayItem' }
    }
  ],
  // The relays serve the e2ee families only to a signed-in orderer or site
  // reader: the grant wallets above, with the roles the relays give them.
  relayAccess: {
    readers: [
      {
        wallet: ORDERER_WALLET,
        roles: ['orderer'],
        reason: 'The orderer the dm seed signs in as'
      },
      {
        wallet: READER_WALLET,
        roles: ['site-reader'],
        reason: 'The site reader the dm rebuild reads every family as'
      }
    ]
  },
  probes: PROBES,
  waivers: {
    unprobedTables: [
      ...[
        'content_moderation_items',
        'content_moderation_reports',
        'e2ee_report_access_log',
        'e2ee_reports'
      ].map((target) => ({
        target,
        reason:
          'Read only by moderators (the moderation developer group). A moderator fixture comes with the group fixtures; until then the run compares these rows table by table.'
      })),
      {
        target: 'e2ee_group_epochs',
        reason:
          'No GET route reads it: writes check a commit against the epoch keys. The run compares its rows table by table.'
      },
      {
        target: 'e2ee_record_items',
        reason:
          'The DEL index: no GET route reads it. The run compares its rows table by table.'
      },
      {
        target: 'e2ee_streams',
        reason:
          "The relay index's stream heads: no GET route reads it. The run compares its rows table by table."
      }
    ]
  }
};
