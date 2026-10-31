import {
  AD_DROP_LINKS,
  AD_SOURCES
} from '@/artwork-documentation/artwork-documentation.tables';
import {
  ACTIVITY_EVENTS_TABLE,
  ART_CURATION_TOKEN_WATCH_DROPS_TABLE,
  ART_CURATION_TOKEN_WATCHES_TABLE,
  ATTACHMENTS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE,
  CONTENT_MODERATION_EVALUATIONS_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  DELETED_DROPS_TABLE,
  DEVICE_SIGNED_EVENTS_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_AUTHOR_SIGNATURES_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_CURATIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MEDIA_UPLOADS_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_METADATA_TABLE,
  DROP_NFT_LINKS_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLLS_TABLE,
  DROP_QUICKVOTE_SKIPS_TABLE,
  DROP_REACTIONS_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_RELATIONS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  HELP_BOT_INTERACTIONS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  OFFICIAL_WAVES_TABLE,
  PINNED_WAVES_TABLE,
  PROFILE_WAVES_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CHAT_DROP_COOLDOWNS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_READER_METRICS_TABLE,
  WAVE_SCORE_REFRESH_REQUESTS_TABLE,
  WAVES_ARCHIVE_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE,
  WS_CONNECTIONS_TABLE
} from '@/constants';

/**
 * Inventory of everything 6529.io stores about an unencrypted DM, for the
 * D146 deletion (2026-12-01). A DM is a wave with `waves.is_direct_message`
 * whose chat group is a DM group (`community_groups.is_direct_message`);
 * both flags must agree before anything is touched.
 *
 * `legacy-dm-purge.inventory.test.ts` reads every entity file and fails when
 * a table that carries a drop or wave reference is in neither list, so a new
 * table cannot silently keep DM content after the deletion.
 */

/** Selects the ids of DM waves whose two flags agree. */
export const DM_WAVES_SQL = `select w.id from ${WAVES_TABLE} w
  join ${USER_GROUPS_TABLE} g on g.id = w.chat_group_id
  where w.is_direct_message = 1 and g.is_direct_message = 1`;

/** Tables deleted by `drop_id in (batch)`. Order matters only for readability. */
export const LEGACY_DM_DROP_ID_TABLES: readonly string[] = [
  DROPS_PARTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_METADATA_TABLE,
  DROP_REACTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLLS_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_NFT_LINKS_TABLE,
  DROP_CURATIONS_TABLE,
  DROP_QUICKVOTE_SKIPS_TABLE,
  ART_CURATION_TOKEN_WATCH_DROPS_TABLE,
  DROP_AUTHOR_SIGNATURES_TABLE,
  DROP_MEDIA_UPLOADS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE
];

/**
 * A purge step for one batch of DM drop ids. `where` uses `?` placeholders,
 * each bound to the batch's id list; `selfTable` is the table rows leave.
 */
export interface LegacyDmDropStep {
  readonly table: string;
  readonly where: string;
  /** How many times the id list is bound. */
  readonly bindings: number;
}

const MODERATION_ITEM_FOR_DROPS = `subject_type = 'DROP' and (subject_id in (?) or published_subject_id in (?))`;

/** Steps beyond the plain `drop_id` tables, applied to the same batch. */
export const LEGACY_DM_DROP_STEPS: readonly LegacyDmDropStep[] = [
  {
    table: CONTENT_MODERATION_EVALUATIONS_TABLE,
    where: `item_id in (select id from ${CONTENT_MODERATION_ITEMS_TABLE} where ${MODERATION_ITEM_FOR_DROPS})`,
    bindings: 2
  },
  {
    table: CONTENT_MODERATION_ITEMS_TABLE,
    where: MODERATION_ITEM_FOR_DROPS,
    bindings: 2
  },
  {
    table: CONTENT_MODERATION_AUDIT_LOG_TABLE,
    where: 'target_drop_id in (?)',
    bindings: 1
  },
  { table: ACTIVITY_EVENTS_TABLE, where: 'drop_id in (?)', bindings: 1 },
  {
    table: ACTIVITY_EVENTS_TABLE,
    where: `target_type = 'DROP' and target_id in (?)`,
    bindings: 1
  },
  {
    table: IDENTITY_SUBSCRIPTIONS_TABLE,
    where: `target_type = 'DROP' and target_id in (?)`,
    bindings: 1
  },
  {
    table: DROP_RELATIONS_TABLE,
    where: 'parent_id in (?) or child_id in (?)',
    bindings: 2
  },
  { table: DEVICE_SIGNED_EVENTS_TABLE, where: 'drop_id in (?)', bindings: 1 },
  {
    table: HELP_BOT_INTERACTIONS_TABLE,
    where:
      'trigger_drop_id in (?) or target_drop_id in (?) or bot_reply_drop_id in (?)',
    bindings: 3
  }
];

/** Notifications that point at a batch's drops (cancelled, then deleted). */
export const NOTIFICATIONS_FOR_DROPS =
  'related_drop_id in (?) or related_drop_2_id in (?)';

/**
 * Wave-level steps, run once per DM wave after its drops are gone. Each
 * `where` binds the wave id once. They catch rows that never had a drop:
 * pre-publication evidence of rejected drafts, unattached uploads, and
 * notifications or events keyed only by wave.
 */
export const LEGACY_DM_WAVE_STEPS: readonly LegacyDmDropStep[] = [
  {
    table: CONTENT_MODERATION_EVALUATIONS_TABLE,
    where: `item_id in (select id from ${CONTENT_MODERATION_ITEMS_TABLE} where subject_type = 'DROP' and json_unquote(json_extract(scope, '$.wave_id')) = ?)`,
    bindings: 1
  },
  {
    table: CONTENT_MODERATION_ITEMS_TABLE,
    where: `subject_type = 'DROP' and json_unquote(json_extract(scope, '$.wave_id')) = ?`,
    bindings: 1
  },
  { table: DEVICE_SIGNED_EVENTS_TABLE, where: 'wave_id = ?', bindings: 1 },
  { table: HELP_BOT_INTERACTIONS_TABLE, where: 'wave_id = ?', bindings: 1 },
  { table: DROP_MEDIA_UPLOADS_TABLE, where: 'wave_id = ?', bindings: 1 },
  { table: ACTIVITY_EVENTS_TABLE, where: 'wave_id = ?', bindings: 1 },
  { table: DROP_REACTIONS_TABLE, where: 'wave_id = ?', bindings: 1 }
];

/** The fixed text every DM description drop is created with. */
export const DM_DESCRIPTION_DEFAULT_CONTENT = 'gm! :gm1:';

/**
 * Tables the description drop keeps: its row and its first part, reset to
 * the default text. Every other drop-keyed row of it is deleted.
 */
export const DESCRIPTION_DROP_KEPT_TABLES: readonly string[] = [
  DROPS_TABLE,
  DROPS_PARTS_TABLE
];

/**
 * Tables that reference DM drops or waves and are deliberately kept, with
 * the reason. None holds message content. Whether the owner also wants this
 * metadata gone is an open question of D146.
 */
export const LEGACY_DM_KEPT_TABLES: Readonly<Record<string, string>> = {
  [WAVES_TABLE]:
    'The conversation shell (name from member handles, group, creator, times); links keep resolving and show the history as deleted',
  [WAVES_ARCHIVE_TABLE]: 'Snapshots of the wave shell; no message content',
  [WAVES_METADATA_TABLE]: 'Wave settings; no message content',
  [USER_GROUPS_TABLE]: 'The DM membership group; no message content',
  [DELETED_DROPS_TABLE]:
    'Tombstones (id, wave, author, times) of drops deleted earlier; no content',
  [WAVE_METRICS_TABLE]: 'Counters; decremented by the purge',
  [WAVE_DROPPER_METRICS_TABLE]: 'Per-author counters; decremented by the purge',
  [WAVE_READER_METRICS_TABLE]: 'Read cursors and unread state; no content',
  [WAVE_CHAT_DROP_COOLDOWNS_TABLE]: 'Slow-mode timestamps; no content',
  [PINNED_WAVES_TABLE]: 'A member pinned the DM; no content',
  [PROFILE_WAVES_TABLE]: 'Profile wave pins; no content',
  [WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE]:
    'Notification preferences; no content',
  [WS_CONNECTIONS_TABLE]: 'Live socket subscriptions; no content',
  [IDENTITY_NOTIFICATIONS_TABLE]:
    'Deleted by drop and by wave through push cancellation, not by a plain step',
  [PUSH_NOTIFICATION_CANCELLATIONS_TABLE]:
    'Receives the cancelled notification ids so queued pushes are dropped',
  [ATTACHMENTS_TABLE]:
    'Deleted only when no remaining drop links the attachment (shared assets survive)',
  [DROPS_TABLE]: 'Deleted by id after every drop-owned row is gone',
  [COMPETITION_ENTRIES_TABLE]:
    'DM waves are chat-only; any entry makes the purge refuse to run',
  [ART_CURATION_TOKEN_WATCHES_TABLE]:
    'Wave-level watch; any watch on a DM wave makes the purge refuse to run',
  [OFFICIAL_WAVES_TABLE]: 'Official wave registry; DMs are never official',
  [WAVE_CURATIONS_TABLE]: 'Curation group definitions; entries are purged',
  [WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE]:
    'Metrics refresh queue; no content',
  [WAVE_SCORE_REFRESH_REQUESTS_TABLE]: 'Score refresh queue; no content',
  [AD_SOURCES]:
    "An author's own deliberate import of their drop into artwork documentation; counted by the plan, kept pending the owner's call",
  [AD_DROP_LINKS]: 'Links of those imports; kept with them'
};

/** Author-imported copies of DM drops in artwork documentation (reported). */
export const DOCUMENTATION_IMPORTS_SQL = `select count(*) as c from ${AD_SOURCES} s
  join ${AD_DROP_LINKS} l on l.drop_id = s.drop_id
  where l.wave_id in (${DM_WAVES_SQL})`;

/** Rows that must not exist in DM waves; the purge refuses while any do. */
export const LEGACY_DM_BLOCKERS: readonly { name: string; sql: string }[] = [
  {
    name: 'competition entries in DM waves',
    sql: `select count(*) as c from ${COMPETITION_ENTRIES_TABLE} where wave_id in (${DM_WAVES_SQL})`
  },
  {
    name: 'art curation watches on DM waves',
    sql: `select count(*) as c from ${ART_CURATION_TOKEN_WATCHES_TABLE} where wave_id in (${DM_WAVES_SQL})`
  },
  {
    name: 'waves whose parent is a DM wave',
    sql: `select count(*) as c from ${WAVES_TABLE} where parent_wave_id in (${DM_WAVES_SQL})`
  }
];

/** DM-flagged waves whose group flag disagrees; reported, never touched. */
export const INCONSISTENT_DM_WAVES_SQL = `select count(*) as c from ${WAVES_TABLE} w
  left join ${USER_GROUPS_TABLE} g on g.id = w.chat_group_id
  where (w.is_direct_message = 1) <> (coalesce(g.is_direct_message, 0) = 1)
    and (w.is_direct_message = 1 or g.is_direct_message = 1)`;
