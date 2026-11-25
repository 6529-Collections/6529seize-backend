import { AreaManifest } from '@/rebuild/manifest.types';

/**
 * Encrypted direct messages and reports to moderators.
 */
export const dmManifest: AreaManifest = {
  area: 'dm',
  flags: {},
  tables: {
    e2ee_backup_chunks: { class: 'INDEX' },
    e2ee_backups: { class: 'INDEX' },
    e2ee_blob_chunks: { class: 'INDEX' },
    e2ee_blobs: { class: 'INDEX' },
    e2ee_ciphertext_objects: { class: 'INDEX' },
    e2ee_devices: { class: 'INDEX' },
    e2ee_group_epochs: { class: 'INDEX' },
    e2ee_group_roster: { class: 'INDEX' },
    e2ee_groups: { class: 'INDEX' },
    e2ee_key_packages: {
      class: 'EPHEMERAL',
      why: 'One-time KeyPackages; devices upload fresh ones.'
    },
    e2ee_log: { class: 'INDEX' },
    e2ee_push_throttle: { class: 'EPHEMERAL', why: 'Rate state.' },
    e2ee_rate_counters: { class: 'EPHEMERAL', why: 'Rate state.' },
    e2ee_welcome_deliveries: { class: 'INDEX' },
    e2ee_welcomes: { class: 'INDEX' },
    abusiveness_detection_results: {
      class: 'EPHEMERAL',
      why: 'Automated check results; checks run again on demand.'
    },
    content_moderation_evaluations: {
      class: 'EPHEMERAL',
      why: 'Automated check results; checks run again on demand.'
    },
    content_moderation_items: { class: 'INDEX' },
    content_moderation_pre_publication_checks: {
      class: 'EPHEMERAL',
      why: 'Automated check results; checks run again on demand.'
    },
    content_moderation_reports: { class: 'INDEX' },
    e2ee_report_access_log: { class: 'INDEX' },
    e2ee_reports: { class: 'INDEX' },
    e2ee_streams: { class: 'INDEX', origin: 'planned' },
    e2ee_relay_outbox: {
      class: 'EPHEMERAL',
      why: 'Records not yet on every relay; a row goes once every relay holds it.',
      origin: 'planned'
    }
  },
  seeds: [],
  rebuilders: [],
  probes: []
};
