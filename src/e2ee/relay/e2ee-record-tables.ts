import {
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
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';
import { E2eeRow, E2eeRowValue } from '@/e2ee/relay/e2ee-record-container';

/** How a column is carried in a record and written back by the rebuild. */
export type E2eeColumnKind = 'text' | 'int' | 'bool' | 'bin';

export interface E2eeRecordTable {
  readonly name: string;
  readonly key: readonly string[];
  readonly columns: Readonly<Record<string, E2eeColumnKind>>;
}

function table(
  name: string,
  key: readonly string[],
  columns: Record<string, E2eeColumnKind>
): E2eeRecordTable {
  return { name, key, columns };
}

/**
 * Every table the delivery service's records carry, with every column. The
 * orderer copies rows column for column, and the rebuild writes them back
 * column for column, so the API reads the same rows either way.
 *
 * Not carried: `e2ee_devices.last_seen_at` (activity, rebuilt from the log)
 * and the four `registered_*` columns (how a device was registered: no
 * route reads them). Both are ephemeral.
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
  })
};

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

/** Selects every carried column, bytes as base64 (the caster's safe form). */
export function e2eeRecordSelectList(target: E2eeRecordTable): string {
  return Object.entries(target.columns)
    .map(([column, kind]) =>
      kind === 'bin' ? `to_base64(${column}) as ${column}` : column
    )
    .join(', ');
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
