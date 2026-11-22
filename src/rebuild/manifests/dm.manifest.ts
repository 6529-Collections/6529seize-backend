import { AreaManifest } from '@/rebuild/manifest.types';

const STEPS = 'src/e2ee/relay/e2ee-rebuild-check.steps';

/**
 * The tables the relay records carry (the delivery service's, and the
 * reports in the moderators' inbox), and the stream heads.
 */
const RECORD_TABLES = [
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
  'e2ee_streams'
];

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
  wallet: `0x${'aa'.repeat(20)}`,
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
  wallet: `0x${'bb'.repeat(20)}`,
  device_key:
    '0xfd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618',
  scopes: ['post'],
  domain: '6529 Network P2P',
  expires_at: 4102444800000,
  revoked_at: null
});

/**
 * Encrypted direct messages and reports to moderators.
 * Classes start from the migration map; this manifest confirms or changes
 * each one.
 */
export const dmManifest: AreaManifest = {
  area: 'dm',
  flags: {
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
    // The moderation review queue's items: the AI outcome per content
    // fingerprint (rerun on demand) and moderators' decisions (override,
    // permit, suppressed), which move to records of their own later. Not
    // rebuilt until then.
    content_moderation_items: { class: 'INDEX' },
    content_moderation_pre_publication_checks: {
      class: 'EPHEMERAL',
      why: 'The duplicate fingerprint and the hourly budget of pre-publication checks, pruned at 30 days.'
    },
    // Reports and their access log: the moderators' inbox (md), sealed to
    // the moderation service key. Reports on legacy DMs go with the DMs on
    // 1 Dec and are never recorded.
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
    }
  },
  seeds: [
    {
      id: 'dm.e2ee.seed',
      run: { module: STEPS, exportName: 'seedE2ee' },
      writes: [
        ...RECORD_TABLES,
        'e2ee_relay_outbox',
        // The report path's own audit row (a moderation table).
        'content_moderation_audit_log'
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
  probes: []
};
