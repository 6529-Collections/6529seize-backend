import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  DELETED_DROPS_TABLE,
  DROPS_TABLE,
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_CIPHERTEXT_OBJECTS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_EPOCHS_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '@/constants/db-tables';
import { E2eeRow, E2eeRowValue } from '@/e2ee/relay/e2ee-record-container';

/**
 * How a column is carried in a record and written back by the rebuild.
 * `json` and `decimal` travel as MySQL's own text for them, so a rebuilt
 * row reads back exactly as the original.
 */
export type E2eeColumnKind =
  | 'text'
  | 'int'
  | 'bool'
  | 'bin'
  | 'json'
  | 'decimal';

export interface E2eeRecordTable {
  readonly name: string;
  readonly key: readonly string[];
  readonly columns: Readonly<Record<string, E2eeColumnKind>>;
  /** Which rows are recorded, when not all are (an SQL condition). */
  readonly scope?: string;
}

function table(
  name: string,
  key: readonly string[],
  columns: Record<string, E2eeColumnKind>,
  scope?: string
): E2eeRecordTable {
  return scope ? { name, key, columns, scope } : { name, key, columns };
}

/**
 * Waves known to be public: a live wave neither of whose DM flags is set
 * (the wave's or its chat group's). A deleted wave is not known, so
 * nothing about it is recorded.
 */
const PUBLIC_WAVES = `select pw.id from ${WAVES_TABLE} pw
  left join ${USER_GROUPS_TABLE} pg on pg.id = pw.chat_group_id
  where coalesce(pw.is_direct_message, 0) = 0
    and coalesce(pg.is_direct_message, 0) = 0`;

/**
 * Drops known to be in a public wave, live or deleted (a deleted drop keeps
 * its wave in `deleted_drops`; author deletes are hard deletes).
 */
const PUBLIC_DROPS = `select ld.id from ${DROPS_TABLE} ld
    where ld.wave_id in (${PUBLIC_WAVES})
  union
  select dd.id from ${DELETED_DROPS_TABLE} dd
    where dd.wave_id in (${PUBLIC_WAVES})`;

/**
 * Reports and moderation items on legacy plaintext DMs stay off the relays:
 * those drops are deleted on 1 Dec (D153), and a DM's text must never
 * reach a relay. A report or a drop's item is recorded only when its drop
 * is known to be in a public wave, live or deleted; one whose drop or wave
 * cannot be found is not recorded either.
 */
const PUBLIC_DROP_REPORT = `${CONTENT_MODERATION_REPORTS_TABLE}.drop_id in (
  ${PUBLIC_DROPS})`;
const PUBLIC_ITEM = `(${CONTENT_MODERATION_ITEMS_TABLE}.subject_type <> 'DROP'
  or coalesce(${CONTENT_MODERATION_ITEMS_TABLE}.published_subject_id,
              ${CONTENT_MODERATION_ITEMS_TABLE}.subject_id)
     in (${PUBLIC_DROPS}))`;

/**
 * Moderation items whose moderators' decisions are recorded: an override,
 * a permit (granted or used), a suppression, or a report's item.
 */
export const E2EE_DECIDED_ITEM_SQL = `(override is not null
  or permit_expires_at is not null or permit_consumed_at is not null
  or suppressed = true or operation = 'REPORT')`;

/**
 * Every table the delivery service's records carry, with every column. The
 * orderer copies rows column for column, and the rebuild writes them back
 * column for column, so the API reads the same rows either way.
 *
 * Not carried: `e2ee_devices.last_seen_at` (activity, rebuilt from the log)
 * and the four `registered_*` columns (how a device was registered: no
 * route reads them). Both are ephemeral.
 *
 * The report tables are carried in the moderators' inbox, sealed to
 * the moderation service key.
 */
export const E2EE_RECORD_TABLES: Readonly<Record<string, E2eeRecordTable>> = {
  [E2EE_GROUPS_TABLE]: table(E2EE_GROUPS_TABLE, ['group_handle'], {
    group_handle: 'text',
    epoch: 'int',
    commit_key: 'text',
    last_seq: 'int',
    created_by_profile_id: 'text',
    created_at: 'int',
    updated_at: 'int'
  }),
  [E2EE_GROUP_EPOCHS_TABLE]: table(
    E2EE_GROUP_EPOCHS_TABLE,
    ['group_handle', 'epoch'],
    {
      group_handle: 'text',
      epoch: 'int',
      commit_key: 'text',
      created_at: 'int'
    }
  ),
  [E2EE_GROUP_ROSTER_TABLE]: table(E2EE_GROUP_ROSTER_TABLE, ['id'], {
    id: 'int',
    group_handle: 'text',
    device_key: 'text',
    profile_id: 'text',
    joined_epoch: 'int',
    removed_epoch: 'int',
    added_at: 'int',
    removed_at: 'int',
    removal_kind: 'text'
  }),
  [E2EE_LOG_TABLE]: table(E2EE_LOG_TABLE, ['group_handle', 'seq'], {
    group_handle: 'text',
    seq: 'int',
    item_type: 'text',
    epoch: 'int',
    kind: 'int',
    commit_epoch: 'int',
    data: 'bin',
    padded_len: 'int',
    entry_hash: 'text',
    epoch_commitment: 'text',
    next_commit_key: 'text',
    signature: 'text',
    roster_add: 'text',
    roster_remove: 'text',
    epoch_fp: 'text',
    sender_device_key: 'text',
    sender_profile_id: 'text',
    created_at: 'int'
  }),
  [E2EE_WELCOMES_TABLE]: table(E2EE_WELCOMES_TABLE, ['id'], {
    id: 'text',
    group_handle: 'text',
    epoch: 'int',
    data: 'bin',
    ratchet_tree: 'bin',
    added_by_profile_id: 'text',
    added_by_device_key: 'text',
    created_at: 'int'
  }),
  [E2EE_WELCOME_DELIVERIES_TABLE]: table(
    E2EE_WELCOME_DELIVERIES_TABLE,
    ['welcome_id', 'device_key'],
    {
      welcome_id: 'text',
      device_key: 'text',
      profile_id: 'text',
      created_at: 'int'
    }
  ),
  [E2EE_BLOBS_TABLE]: table(E2EE_BLOBS_TABLE, ['blob_id'], {
    blob_id: 'text',
    group_handle: 'text',
    uploader_device_key: 'text',
    uploader_profile_id: 'text',
    size: 'int',
    chunk_count: 'int',
    complete: 'bool',
    created_at: 'int',
    completed_at: 'int',
    storage: 'text',
    storage_location: 'text'
  }),
  [E2EE_BLOB_CHUNKS_TABLE]: table(
    E2EE_BLOB_CHUNKS_TABLE,
    ['blob_id', 'chunk_index'],
    {
      blob_id: 'text',
      chunk_index: 'int',
      data: 'bin',
      size: 'int',
      created_at: 'int'
    }
  ),
  [E2EE_BACKUPS_TABLE]: table(E2EE_BACKUPS_TABLE, ['backup_id'], {
    backup_id: 'text',
    profile_id: 'text',
    envelope: 'bin',
    active: 'bool',
    next_seq: 'int',
    chunk_count: 'int',
    size: 'int',
    created_by_device_key: 'text',
    created_at: 'int',
    updated_at: 'int',
    activated_at: 'int'
  }),
  [E2EE_BACKUP_CHUNKS_TABLE]: table(
    E2EE_BACKUP_CHUNKS_TABLE,
    ['backup_id', 'seq'],
    {
      backup_id: 'text',
      seq: 'int',
      profile_id: 'text',
      size: 'int',
      object_key: 'text',
      uploader_device_key: 'text',
      created_at: 'int'
    }
  ),
  [E2EE_CIPHERTEXT_OBJECTS_TABLE]: table(
    E2EE_CIPHERTEXT_OBJECTS_TABLE,
    ['object_key'],
    { object_key: 'text', data: 'bin', created_at: 'int' }
  ),
  [E2EE_DEVICES_TABLE]: table(E2EE_DEVICES_TABLE, ['device_key'], {
    device_key: 'text',
    profile_id: 'text',
    wallet: 'text',
    ciphersuite: 'int',
    grant_version: 'int',
    ciphersuites: 'text',
    issued_at_seconds: 'int',
    expires_at_seconds: 'int',
    origin: 'text',
    grant_id: 'text',
    wallet_signature: 'text',
    verified_via: 'text',
    label: 'text',
    platform: 'text',
    created_at: 'int',
    updated_at: 'int',
    revoked_at: 'int',
    revoker_device_key: 'text',
    revocation_signed_at_seconds: 'int',
    revocation_signature: 'text',
    grant_message: 'text',
    notice_pending: 'bool'
  }),
  [E2EE_KEY_PACKAGES_TABLE]: table(E2EE_KEY_PACKAGES_TABLE, ['id'], {
    id: 'int',
    device_key: 'text',
    data: 'bin',
    last_resort: 'bool',
    ciphersuite: 'int',
    expires_at_seconds: 'int',
    created_at: 'int'
  }),
  [CONTENT_MODERATION_REPORTS_TABLE]: table(
    CONTENT_MODERATION_REPORTS_TABLE,
    ['id'],
    {
      id: 'text',
      item_id: 'text',
      drop_id: 'text',
      reporter_profile_id: 'text',
      author_profile_id: 'text',
      reason: 'text',
      notes: 'text',
      content_snapshot: 'json',
      status: 'text',
      ai_recommendation: 'text',
      ai_category: 'text',
      ai_confidence: 'decimal',
      ai_rationale: 'text',
      ai_evidence: 'json',
      ai_policy_version: 'text',
      ai_assessed_at: 'int',
      created_at: 'int',
      resolved_by_profile_id: 'text',
      resolution_reason: 'text',
      resolved_at: 'int',
      hide_drop: 'bool',
      block_author: 'bool'
    },
    PUBLIC_DROP_REPORT
  ),
  [E2EE_REPORTS_TABLE]: table(E2EE_REPORTS_TABLE, ['id'], {
    id: 'text',
    group_handle: 'text',
    epoch: 'int',
    body: 'bin',
    signature: 'text',
    sender_device_key: 'text',
    sender_profile_id: 'text',
    reporter_device_key: 'text',
    reporter_profile_id: 'text',
    reason: 'text',
    notes: 'text',
    verified: 'bool',
    created_at: 'int',
    on_hold: 'bool'
  }),
  [E2EE_REPORT_ACCESS_LOG_TABLE]: table(E2EE_REPORT_ACCESS_LOG_TABLE, ['id'], {
    id: 'int',
    viewer_profile_id: 'text',
    action: 'text',
    report_ids: 'text',
    created_at: 'int'
  }),
  // A moderation item's identity and its moderators' decisions. The AI
  // result columns (evidence, outcome, trigger, evidence_expires_at,
  // version, updated_at) are not carried: they are rerun on demand.
  [CONTENT_MODERATION_ITEMS_TABLE]: table(
    CONTENT_MODERATION_ITEMS_TABLE,
    ['id'],
    {
      id: 'text',
      subject_type: 'text',
      subject_id: 'text',
      author_profile_id: 'text',
      actor_profile_id: 'text',
      operation: 'text',
      policy_family: 'text',
      policy_version: 'text',
      content_fingerprint: 'text',
      scope: 'json',
      review_status: 'text',
      override: 'text',
      permit_expires_at: 'int',
      permit_consumed_at: 'int',
      published_subject_id: 'text',
      suppressed: 'bool',
      created_at: 'int'
    },
    PUBLIC_ITEM
  )
};

/**
 * The items a record carries that the delivery service may later delete
 * or expire, so a DEL can name the record then: a Welcome in a device
 * inbox, a backup chunk's bytes, an attachment (every record of its
 * stream), a report row. Derived from the record's own operations, so the
 * rebuild finds the same keys.
 */
export function e2eeItemKeysOf(
  family: string,
  ops: readonly {
    readonly op: string;
    readonly table: string;
    readonly row?: E2eeRow;
  }[]
): string[] {
  const puts = (table: string) =>
    ops.filter((op) => op.op === 'put' && op.table === table && op.row);
  switch (family) {
    case 'dv':
      return puts(E2EE_WELCOME_DELIVERIES_TABLE).map(
        (op) => `welcome:${String(op.row!.welcome_id)}`
      );
    case 'bl':
      return ['blob'];
    case 'bk':
      return puts(E2EE_CIPHERTEXT_OBJECTS_TABLE).map(
        (op) => `object:${String(op.row!.object_key)}`
      );
    case 'md':
      return [CONTENT_MODERATION_REPORTS_TABLE, E2EE_REPORTS_TABLE].flatMap(
        (table) => puts(table).map((op) => `${table}:${String(op.row!.id)}`)
      );
    default:
      return [];
  }
}

/** The tables the moderators' inbox carries. */
export const E2EE_MODERATION_TABLES: readonly string[] = [
  CONTENT_MODERATION_REPORTS_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE
];

export function e2eeRecordTable(name: string): E2eeRecordTable {
  const found = E2EE_RECORD_TABLES[name];
  if (!found) throw new Error(`Not a recorded e2ee table: ${name}`);
  return found;
}

/** A column as MySQL returns it, made a record value of its kind. */
function normalizeValue(kind: E2eeColumnKind, value: unknown): E2eeRowValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'int':
      return Number(value);
    case 'bool':
      return value === true || Number(value) === 1;
    case 'bin':
      if (Buffer.isBuffer(value)) return Buffer.from(value);
      return Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
    default:
      return String(value);
  }
}

/**
 * Selects every carried column: bytes as base64 (the caster's safe form),
 * JSON and decimals as MySQL's text for them.
 */
export function e2eeRecordSelectList(target: E2eeRecordTable): string {
  return Object.entries(target.columns)
    .map(([column, kind]) => {
      if (kind === 'bin') return `to_base64(${column}) as ${column}`;
      if (kind === 'json' || kind === 'decimal') {
        return `cast(${column} as char) as ${column}`;
      }
      return column;
    })
    .join(', ');
}

/** The table's scope as a `where` clause, or `extra` alone (or nothing). */
export function e2eeRecordWhere(
  target: E2eeRecordTable,
  extra: readonly string[] = []
): string {
  const clauses = [...(target.scope ? [target.scope] : []), ...extra];
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

/** A MySQL row, normalized to the table's column kinds. */
export function e2eeRecordRow(
  target: E2eeRecordTable,
  raw: Readonly<Record<string, unknown>>
): E2eeRow {
  const row: Record<string, E2eeRowValue> = {};
  for (const [column, kind] of Object.entries(target.columns)) {
    row[column] = normalizeValue(kind, raw[column]);
  }
  return row;
}

/** The key columns of a row. */
export function e2eeRecordKey(target: E2eeRecordTable, row: E2eeRow): E2eeRow {
  const key: Record<string, E2eeRowValue> = {};
  for (const column of target.key) {
    const value = row[column];
    if (value === undefined) {
      throw new Error(`${target.name} key column ${column} is missing`);
    }
    key[column] = value;
  }
  return key;
}

/** A stable string for a row's key, for maps keyed by primary key. */
export function e2eeRecordKeyString(
  target: E2eeRecordTable,
  row: E2eeRow
): string {
  return JSON.stringify(
    target.key.map((column) => {
      const value = row[column];
      return Buffer.isBuffer(value) ? value.toString('hex') : value;
    })
  );
}
