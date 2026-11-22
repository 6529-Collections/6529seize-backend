import { createHash } from 'node:crypto';
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
import { DbQueryOptions } from '@/db-query.options';
import {
  E2eeExternalBytes,
  E2eeRow,
  E2eeRowOp,
  E2eeRowValue
} from '@/e2ee/relay/e2ee-record-container';
import { E2eeRecordKind } from '@/e2ee/relay/e2ee-record-event';
import {
  e2eeRecordRow,
  e2eeRecordSelectList,
  e2eeRecordTable
} from '@/e2ee/relay/e2ee-record-tables';
import {
  E2eeDeliveryWindow,
  E2eeRecordAppend,
  E2eeRecordBatch
} from '@/e2ee/relay/e2ee-stream-publisher';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;
type Where = Readonly<Record<string, E2eeRowValue | readonly E2eeRowValue[]>>;

/** Reads rows of the recorded tables, column for column, in a transaction. */
export class E2eeRecordRowReader extends LazyDbAccessCompatibleService {
  async rows(
    tableName: string,
    where: Where,
    connection: Conn,
    orderBy?: string
  ): Promise<E2eeRow[]> {
    const target = e2eeRecordTable(tableName);
    const params: Record<string, unknown> = {};
    const clauses = Object.entries(where).map(([column, value], index) => {
      if (!(column in target.columns)) {
        throw new Error(`${tableName} has no column ${column}`);
      }
      params[`w${index}`] = value;
      if (Array.isArray(value)) return `${column} in (:w${index})`;
      return value === null ? `${column} is null` : `${column} = :w${index}`;
    });
    if (Object.values(where).some((v) => Array.isArray(v) && !v.length)) {
      return [];
    }
    const options: DbQueryOptions = { wrappedConnection: connection };
    const raw = await this.db.execute<Record<string, unknown>>(
      `select ${e2eeRecordSelectList(target)} from ${tableName}
       ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
       ${orderBy ? `order by ${orderBy}` : ''}`,
      params,
      options
    );
    return raw.map((row) => e2eeRecordRow(target, row));
  }
}

export const e2eeRecordRowReader = new E2eeRecordRowReader(dbSupplier);

function puts(table: string, rows: readonly E2eeRow[]): E2eeRowOp[] {
  return rows.map((row) => ({ op: 'put', table, row }));
}

function windowsOf(roster: readonly E2eeRow[]): E2eeDeliveryWindow[] {
  return roster.map((row) => ({
    d: String(row.device_key),
    from: Number(row.joined_epoch),
    to: row.removed_epoch === null ? null : Number(row.removed_epoch)
  }));
}

function groupLog(
  group: string,
  type: string,
  ops: readonly E2eeRowOp[],
  epoch: number | null,
  roster: readonly E2eeRow[]
): E2eeRecordAppend {
  return {
    family: 'cv',
    owner: group,
    kind: E2eeRecordKind.LOG,
    refs: [type],
    type,
    ops,
    log: { epoch, windows: windowsOf(roster) }
  };
}

/**
 * The stream owner for a profile's backups. The relay families key `bk` by
 * principal; until the identity mirror gives each profile its principal id,
 * the owner is a hash of the profile id (only the orderer and the
 * site-reader read it this week).
 */
export function e2eeBackupStreamOwner(profileId: string): string {
  return `0x${createHash('sha256')
    .update(`6529.io e2ee backups ${profileId}`)
    .digest('hex')}`;
}

/**
 * What each write of the delivery service records. Every function reads the
 * rows the write left, in the write's transaction, and appends one record
 * per stream. The records carry whole rows, so the rebuild writes back
 * exactly what MySQL holds.
 */
export class E2eeRecordWriters {
  constructor(
    private readonly reader: Pick<
      E2eeRecordRowReader,
      'rows'
    > = e2eeRecordRowReader
  ) {}

  private async groupRow(group: string, connection: Conn) {
    const [row] = await this.reader.rows(
      E2EE_GROUPS_TABLE,
      { group_handle: group },
      connection
    );
    if (!row) throw new Error(`Group ${group} is gone`);
    return row;
  }

  /**
   * A group's whole state: its row, every epoch key and every roster row.
   * `genesis` when the group is created; `import` when the backfill copies
   * an existing group (under its row lock, so no write interleaves).
   */
  async groupCreated(
    batch: E2eeRecordBatch,
    connection: Conn,
    group: string,
    type: 'genesis' | 'import' = 'genesis'
  ): Promise<void> {
    const groupRow = await this.groupRow(group, connection);
    const epochs = await this.reader.rows(
      E2EE_GROUP_EPOCHS_TABLE,
      { group_handle: group },
      connection,
      'epoch'
    );
    const roster = await this.reader.rows(
      E2EE_GROUP_ROSTER_TABLE,
      { group_handle: group },
      connection,
      'id'
    );
    await batch.append(
      connection,
      groupLog(
        group,
        type,
        [
          ...puts(E2EE_GROUPS_TABLE, [groupRow]),
          ...puts(E2EE_GROUP_EPOCHS_TABLE, epochs),
          ...puts(E2EE_GROUP_ROSTER_TABLE, roster)
        ],
        Number(groupRow.epoch),
        roster
      )
    );
  }

  /**
   * Existing log items copied by the backfill: the item rows only, never
   * the group's state, so a copy appended after newer records cannot undo
   * them. Log items never change; retention only deletes them.
   */
  async logItemsImported(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: { readonly group: string; readonly seqs: readonly number[] }
  ): Promise<number> {
    const items = await this.reader.rows(
      E2EE_LOG_TABLE,
      { group_handle: input.group, seq: input.seqs },
      connection,
      'seq'
    );
    let bytes = 0;
    for (const item of items) {
      if (!Buffer.isBuffer(item.data)) continue;
      bytes += item.data.length;
      await batch.append(connection, {
        family: 'cv',
        owner: input.group,
        kind: E2eeRecordKind.LOG,
        refs: [String(item.item_type)],
        type: String(item.item_type),
        ops: puts(E2EE_LOG_TABLE, [
          { ...item, data: new E2eeExternalBytes(item.data) }
        ]),
        log: { epoch: Number(item.epoch), windows: [] }
      });
    }
    return bytes;
  }

  /**
   * A sequenced log item (an entry or a message): the item, the group's new
   * head, the new epoch's key after a commit, and the roster rows of the
   * devices the item added or removed.
   */
  async itemSequenced(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: {
      readonly group: string;
      readonly seq: number;
      readonly changedDevices: readonly string[];
    }
  ): Promise<void> {
    const [item] = await this.reader.rows(
      E2EE_LOG_TABLE,
      { group_handle: input.group, seq: input.seq },
      connection
    );
    if (!item) throw new Error(`Log item ${input.group}#${input.seq} is gone`);
    const groupRow = await this.groupRow(input.group, connection);
    const epochs =
      item.commit_epoch === null
        ? []
        : await this.reader.rows(
            E2EE_GROUP_EPOCHS_TABLE,
            { group_handle: input.group, epoch: Number(groupRow.epoch) },
            connection
          );
    const roster = await this.reader.rows(
      E2EE_GROUP_ROSTER_TABLE,
      { group_handle: input.group, device_key: input.changedDevices },
      connection,
      'id'
    );
    if (!Buffer.isBuffer(item.data)) throw new Error('Log item has no data');
    await batch.append(
      connection,
      groupLog(
        input.group,
        String(item.item_type),
        [
          ...puts(E2EE_LOG_TABLE, [
            { ...item, data: new E2eeExternalBytes(item.data) }
          ]),
          ...puts(E2EE_GROUPS_TABLE, [groupRow]),
          ...puts(E2EE_GROUP_EPOCHS_TABLE, epochs),
          ...puts(E2EE_GROUP_ROSTER_TABLE, roster)
        ],
        Number(groupRow.epoch),
        roster
      )
    );
  }

  /** Roster changes outside the log: repairs and revocations. */
  async rosterChanged(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: { readonly group: string; readonly devices: readonly string[] }
  ): Promise<void> {
    if (!input.devices.length) return;
    const groupRow = await this.groupRow(input.group, connection);
    const roster = await this.reader.rows(
      E2EE_GROUP_ROSTER_TABLE,
      { group_handle: input.group, device_key: input.devices },
      connection,
      'id'
    );
    await batch.append(
      connection,
      groupLog(
        input.group,
        'roster',
        puts(E2EE_GROUP_ROSTER_TABLE, roster),
        Number(groupRow.epoch),
        roster
      )
    );
  }

  /** A stored Welcome: one record in each target device's inbox. */
  async welcomeStored(
    batch: E2eeRecordBatch,
    connection: Conn,
    welcomeId: string,
    onlyDevice?: string
  ): Promise<void> {
    const [welcome] = await this.reader.rows(
      E2EE_WELCOMES_TABLE,
      { id: welcomeId },
      connection
    );
    if (!welcome) return;
    const deliveries = await this.reader.rows(
      E2EE_WELCOME_DELIVERIES_TABLE,
      onlyDevice === undefined
        ? { welcome_id: welcomeId }
        : { welcome_id: welcomeId, device_key: onlyDevice },
      connection,
      'device_key'
    );
    for (const delivery of deliveries) {
      await batch.append(connection, {
        family: 'dv',
        owner: String(delivery.device_key),
        kind: E2eeRecordKind.SEALED,
        refs: ['welcome'],
        type: 'welcome',
        ops: [
          ...puts(E2EE_WELCOMES_TABLE, [welcome]),
          ...puts(E2EE_WELCOME_DELIVERIES_TABLE, [delivery])
        ]
      });
    }
  }

  /** A device took its Welcome (or never will): the delivery ends. */
  async welcomeAcked(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: { readonly welcomeId: string; readonly deviceKey: string }
  ): Promise<void> {
    await batch.append(connection, {
      family: 'dv',
      owner: input.deviceKey,
      kind: E2eeRecordKind.SEALED,
      refs: ['welcome-ack'],
      type: 'welcome-ack',
      ops: [
        {
          op: 'del',
          table: E2EE_WELCOME_DELIVERIES_TABLE,
          key: { welcome_id: input.welcomeId, device_key: input.deviceKey }
        }
      ]
    });
  }

  /** A device row after any change: registration, renewal, label, revocation. */
  async deviceChanged(
    batch: E2eeRecordBatch,
    connection: Conn,
    deviceKey: string
  ): Promise<void> {
    const [device] = await this.reader.rows(
      E2EE_DEVICES_TABLE,
      { device_key: deviceKey },
      connection
    );
    if (!device) return;
    await batch.append(connection, {
      family: 'dr',
      owner: deviceKey,
      kind: E2eeRecordKind.RECORD,
      refs: ['mls-device'],
      type: 'device',
      ops: puts(E2EE_DEVICES_TABLE, [device])
    });
  }

  /** The groups whose current roster holds the device. */
  async groupsOfDevice(connection: Conn, deviceKey: string): Promise<string[]> {
    const rows = await this.reader.rows(
      E2EE_GROUP_ROSTER_TABLE,
      { device_key: deviceKey, removed_epoch: null },
      connection,
      'id'
    );
    return Array.from(new Set(rows.map((row) => String(row.group_handle))));
  }

  /**
   * A revoked device: its row, and its roster rows in every group it was
   * in. Its KeyPackages and pending Welcomes go with the revocation; the
   * rebuild drops those of revoked devices by the same rule.
   */
  async deviceRevoked(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: { readonly deviceKey: string; readonly groups: readonly string[] }
  ): Promise<void> {
    await this.deviceChanged(batch, connection, input.deviceKey);
    for (const group of input.groups) {
      await this.rosterChanged(batch, connection, {
        group,
        devices: [input.deviceKey]
      });
    }
  }

  /** A device's last-resort KeyPackages of one suite, as they now are. */
  async lastResortChanged(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: { readonly deviceKey: string; readonly ciphersuite: number }
  ): Promise<void> {
    const rows = await this.reader.rows(
      E2EE_KEY_PACKAGES_TABLE,
      {
        device_key: input.deviceKey,
        ciphersuite: input.ciphersuite,
        last_resort: true
      },
      connection,
      'id'
    );
    await batch.append(connection, {
      family: 'dr',
      owner: input.deviceKey,
      kind: E2eeRecordKind.RECORD,
      refs: ['mls-lastresort', String(input.ciphersuite)],
      type: 'last-resort',
      ops: [
        {
          op: 'del',
          table: E2EE_KEY_PACKAGES_TABLE,
          key: {
            device_key: input.deviceKey,
            ciphersuite: input.ciphersuite,
            last_resort: true
          }
        },
        ...puts(E2EE_KEY_PACKAGES_TABLE, rows)
      ]
    });
  }

  /** An attachment chunk as uploaded, bytes included whatever the store. */
  async blobChunkStored(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: {
      readonly blobId: string;
      readonly index: number;
      readonly data: Buffer;
    }
  ): Promise<void> {
    const [chunk] = await this.reader.rows(
      E2EE_BLOB_CHUNKS_TABLE,
      { blob_id: input.blobId, chunk_index: input.index },
      connection
    );
    if (!chunk) return;
    await batch.append(connection, {
      family: 'bl',
      owner: input.blobId,
      kind: E2eeRecordKind.SEALED,
      refs: ['chunk'],
      type: 'chunk',
      ops: puts(E2EE_BLOB_CHUNKS_TABLE, [{ ...chunk, data: input.data }])
    });
  }

  /** An attachment's row, once it is complete. */
  async blobCompleted(
    batch: E2eeRecordBatch,
    connection: Conn,
    blobId: string
  ): Promise<void> {
    const [blob] = await this.reader.rows(
      E2EE_BLOBS_TABLE,
      { blob_id: blobId },
      connection
    );
    if (!blob) return;
    await batch.append(connection, {
      family: 'bl',
      owner: blobId,
      kind: E2eeRecordKind.SEALED,
      refs: ['blob'],
      type: 'blob',
      ops: puts(E2EE_BLOBS_TABLE, [blob])
    });
  }

  /** A generation's chunk seqs up to `throughSeq` (what a compact deletes). */
  async backupChunkSeqs(
    connection: Conn,
    input: { readonly backupId: string; readonly throughSeq: number }
  ): Promise<number[]> {
    const rows = await this.reader.rows(
      E2EE_BACKUP_CHUNKS_TABLE,
      { backup_id: input.backupId },
      connection,
      'seq'
    );
    return rows
      .map((row) => Number(row.seq))
      .filter((seq) => seq <= input.throughSeq);
  }

  /**
   * A profile's backups after a change: every generation row it has now,
   * deletions of the generations and chunks that went, and an appended
   * chunk with its bytes.
   */
  async backupsChanged(
    batch: E2eeRecordBatch,
    connection: Conn,
    input: {
      readonly profileId: string;
      readonly deletedBackups?: readonly string[];
      readonly deletedChunks?: readonly { backupId: string; seq: number }[];
      readonly deletedObjectKeys?: readonly string[];
      readonly appended?: {
        readonly backupId: string;
        readonly seq: number;
        readonly data: Buffer;
      };
    }
  ): Promise<void> {
    const backups = await this.reader.rows(
      E2EE_BACKUPS_TABLE,
      { profile_id: input.profileId },
      connection,
      'backup_id'
    );
    const ops: E2eeRowOp[] = [];
    for (const backupId of input.deletedBackups ?? []) {
      ops.push(
        {
          op: 'del',
          table: E2EE_BACKUP_CHUNKS_TABLE,
          key: { backup_id: backupId }
        },
        { op: 'del', table: E2EE_BACKUPS_TABLE, key: { backup_id: backupId } }
      );
    }
    for (const chunk of input.deletedChunks ?? []) {
      ops.push({
        op: 'del',
        table: E2EE_BACKUP_CHUNKS_TABLE,
        key: { backup_id: chunk.backupId, seq: chunk.seq }
      });
    }
    for (const objectKey of input.deletedObjectKeys ?? []) {
      ops.push({
        op: 'del',
        table: E2EE_CIPHERTEXT_OBJECTS_TABLE,
        key: { object_key: objectKey }
      });
    }
    ops.push(...puts(E2EE_BACKUPS_TABLE, backups));
    if (input.appended) {
      const [chunk] = await this.reader.rows(
        E2EE_BACKUP_CHUNKS_TABLE,
        { backup_id: input.appended.backupId, seq: input.appended.seq },
        connection
      );
      if (chunk) {
        ops.push(...puts(E2EE_BACKUP_CHUNKS_TABLE, [chunk]), {
          op: 'put',
          table: E2EE_CIPHERTEXT_OBJECTS_TABLE,
          row: {
            object_key: chunk.object_key,
            data: input.appended.data,
            created_at: chunk.created_at
          }
        });
      }
    }
    await batch.append(connection, {
      family: 'bk',
      owner: e2eeBackupStreamOwner(input.profileId),
      kind: E2eeRecordKind.SEALED,
      refs: ['backup'],
      type: 'backup',
      ops
    });
  }
}

export const e2eeRecordWriters = new E2eeRecordWriters();
