import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_STREAMS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE,
  PROFILES_TABLE
} from '@/constants/db-tables';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import {
  E2EE_DECIDED_ITEM_SQL,
  e2eeRecordTable,
  e2eeRecordWhere
} from '@/e2ee/relay/e2ee-record-tables';
import { E2eeRecordWriters } from '@/e2ee/relay/e2ee-record-writers';
import {
  E2eeRecordBatch,
  E2eeTransactionRunner
} from '@/e2ee/relay/e2ee-stream-publisher';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;

/**
 * The families the backfill copies, in the order to run them: device
 * records first (the rest names devices), then groups, Welcomes,
 * attachments, backups and the moderators' inbox (reports).
 */
export const E2EE_BACKFILL_FAMILIES = [
  'dr',
  'cv',
  'dv',
  'bl',
  'bk',
  'md'
] as const;
export type E2eeBackfillFamily = (typeof E2EE_BACKFILL_FAMILIES)[number];

/** What a backfill would copy: the dry run's answer. */
export interface E2eeBackfillVolume {
  readonly groups: number;
  readonly entries: number;
  readonly entryBytes: number;
  readonly messages: number;
  readonly messageBytes: number;
  readonly pendingWelcomes: number;
  readonly welcomeBytes: number;
  readonly devices: number;
  readonly lastResortKeyPackages: number;
  readonly completeBlobs: number;
  readonly blobBytes: number;
  readonly backups: number;
  readonly backupChunks: number;
  readonly backupBytes: number;
  readonly reports: number;
  readonly messageReports: number;
  readonly reportAccess: number;
  readonly moderationDecisions: number;
}

/** The volume queries, exactly as the team runs them for the dry run. */
export const E2EE_BACKFILL_VOLUME_SQL = {
  groups: `select count(*) as n from ${E2EE_GROUPS_TABLE}`,
  items: `select item_type, count(*) as n, coalesce(sum(length(data)), 0) as bytes from ${E2EE_LOG_TABLE} group by item_type`,
  welcomes: `select count(*) as n, coalesce(sum(length(w.data) + coalesce(length(w.ratchet_tree), 0)), 0) as bytes from ${E2EE_WELCOME_DELIVERIES_TABLE} d join ${E2EE_WELCOMES_TABLE} w on w.id = d.welcome_id`,
  devices: `select count(*) as n from ${E2EE_DEVICES_TABLE}`,
  lastResort: `select count(*) as n from ${E2EE_KEY_PACKAGES_TABLE} where last_resort = true`,
  blobs: `select count(*) as n, coalesce(sum(size), 0) as bytes from ${E2EE_BLOBS_TABLE} where complete = true`,
  backups: `select count(*) as n from ${E2EE_BACKUPS_TABLE}`,
  backupChunks: `select count(*) as n, coalesce(sum(size), 0) as bytes from ${E2EE_BACKUP_CHUNKS_TABLE}`,
  reports: `select count(*) as n from ${CONTENT_MODERATION_REPORTS_TABLE} ${e2eeRecordWhere(
    e2eeRecordTable(CONTENT_MODERATION_REPORTS_TABLE)
  )}`,
  messageReports: `select count(*) as n from ${E2EE_REPORTS_TABLE}`,
  reportAccess: `select count(*) as n from ${E2EE_REPORT_ACCESS_LOG_TABLE}`,
  moderationDecisions: `select count(*) as n from ${CONTENT_MODERATION_ITEMS_TABLE} ${e2eeRecordWhere(
    e2eeRecordTable(CONTENT_MODERATION_ITEMS_TABLE),
    [E2EE_DECIDED_ITEM_SQL]
  )}`
} as const;

/**
 * A slice of one report table for the moderators' inbox: the keys come as
 * `<table letter>:<id>` (`a` access log, `e` message reports, `i` decided
 * moderation items, `r` reports),
 * so one cursor walks the three tables in turn.
 */
export interface E2eeBackfillReportKey {
  readonly key: string;
  readonly table: string;
  readonly id: string | number;
}

/** Report rows in one md record during the backfill (bodies up to 64 KiB). */
const REPORT_ROWS_PER_RECORD = 20;

export interface E2eeBackfillBlob {
  readonly blob_id: string;
  readonly chunk_count: number;
  readonly storage: string;
  readonly storage_location: string | null;
}

/** What the backfill reads and locks. */
export interface E2eeBackfillDb extends E2eeTransactionRunner {
  volume(): Promise<E2eeBackfillVolume>;
  /** Keys after `after`, in key order (the cursor). */
  groups(after: string, limit: number): Promise<string[]>;
  devices(after: string, limit: number): Promise<string[]>;
  /**
   * Device inboxes to copy: devices with pending Welcomes or closed roster
   * rows, and every inbox stream already recorded (one emptied while
   * records were off still needs its snapshot).
   */
  inboxes(after: string, limit: number): Promise<string[]>;
  completeBlobs(after: string, limit: number): Promise<E2eeBackfillBlob[]>;
  backupProfiles(after: string, limit: number): Promise<string[]>;
  /** Report table keys after `after` (see E2eeBackfillReportKey). */
  reportKeys(after: string, limit: number): Promise<E2eeBackfillReportKey[]>;
  itemSeqs(group: string, throughSeq: number): Promise<number[]>;
  /** Locks the group row; returns its last_seq, or null if gone. */
  lockGroup(group: string, connection: Conn): Promise<number | null>;
  lockDevice(device: string, connection: Conn): Promise<number[] | null>;
  lockBlob(blobId: string, connection: Conn): Promise<boolean>;
  lockBackups(
    profileId: string,
    connection: Conn
  ): Promise<{ backupId: string; seq: number; objectKey: string }[]>;
}

export interface E2eeBackfillDeps {
  readonly db: E2eeBackfillDb;
  readonly writers: E2eeRecordWriters;
  /** Runs a transaction with a record batch (the publisher's `run`). */
  readonly run: <T>(
    work: (connection: Conn, batch: E2eeRecordBatch) => Promise<T>
  ) => Promise<T>;
  readonly blobChunk: (
    blob: E2eeBackfillBlob,
    index: number
  ) => Promise<Buffer | null>;
  readonly backupObject: (objectKey: string) => Promise<Buffer | null>;
  readonly now: () => number;
}

export interface E2eeBackfillRequest {
  /** False (the default) measures only. */
  readonly live: boolean;
  readonly family: E2eeBackfillFamily;
  /** Resume after this key (the last report's `next`). */
  readonly after?: string;
  readonly limit: number;
  readonly timeBudgetMs?: number;
}

export interface E2eeBackfillReport {
  readonly live: boolean;
  readonly family: E2eeBackfillFamily;
  readonly volume: E2eeBackfillVolume;
  readonly examined: number;
  readonly copied: number;
  readonly bytes: number;
  readonly skipped: readonly string[];
  /** Pass as `after` to continue; null when the family is done. */
  readonly next: string | null;
}

const ITEMS_PER_TRANSACTION = 50;
const DEFAULT_TIME_BUDGET_MS = 10 * 60 * 1000;

/**
 * Copies what MySQL holds into the orderer's streams: when records are
 * first switched on, and again after any time they were off. Each entity
 * is copied under the lock its writes take, so a write that comes later is
 * recorded after the copy and wins. The copies are snapshots: a group's
 * epochs and roster, a device inbox's deliveries and a profile's backups
 * are deleted and put again, so deletes and acks made while records were
 * off are carried; log items, attachments and reports change only by
 * retention, which the rebuild applies. Running it twice, or over records
 * the live path wrote, leaves the rebuild unchanged. Legacy plaintext DMs
 * are drops, not delivery-service rows: they are never copied (D153).
 */
export async function backfillE2eeRecords(
  deps: E2eeBackfillDeps,
  request: E2eeBackfillRequest
): Promise<E2eeBackfillReport> {
  const volume = await deps.db.volume();
  const base = { live: request.live, family: request.family, volume };
  if (!request.live) {
    return {
      ...base,
      examined: 0,
      copied: 0,
      bytes: 0,
      skipped: [],
      next: null
    };
  }
  const deadline =
    deps.now() + (request.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const after = request.after ?? '';
  const { keys, full } = await familyKeys(
    deps.db,
    request.family,
    after,
    request.limit
  );
  let copied = 0;
  let bytes = 0;
  let examined = 0;
  const skipped: string[] = [];
  let last: string | null = null;
  for (const key of keys) {
    if (deps.now() >= deadline) break;
    examined++;
    const result = await copyOne(deps, request.family, key);
    if (result === null) skipped.push(key.id);
    else {
      copied++;
      bytes += result;
    }
    last = key.id;
  }
  const done = examined === keys.length && !full;
  return {
    ...base,
    examined,
    copied,
    bytes,
    skipped,
    next: done ? null : last
  };
}

interface FamilyKey {
  readonly id: string;
  readonly blob?: E2eeBackfillBlob;
  /** md: report rows of one table, copied in one record. */
  readonly reports?: {
    readonly table: string;
    readonly ids: readonly (string | number)[];
  };
}

/** The family's next keys, and whether the page was full (more may follow). */
async function familyKeys(
  db: E2eeBackfillDb,
  family: E2eeBackfillFamily,
  after: string,
  limit: number
): Promise<{ readonly keys: FamilyKey[]; readonly full: boolean }> {
  const page = (keys: FamilyKey[]) => ({ keys, full: keys.length >= limit });
  switch (family) {
    case 'dr':
      return page((await db.devices(after, limit)).map((id) => ({ id })));
    case 'cv':
      return page((await db.groups(after, limit)).map((id) => ({ id })));
    case 'dv':
      return page((await db.inboxes(after, limit)).map((id) => ({ id })));
    case 'bl':
      return page(
        (await db.completeBlobs(after, limit)).map((blob) => ({
          id: blob.blob_id,
          blob
        }))
      );
    case 'bk':
      return page(
        (await db.backupProfiles(after, limit)).map((id) => ({ id }))
      );
    case 'md': {
      const rows = await db.reportKeys(after, limit);
      return { keys: reportSlices(rows), full: rows.length >= limit };
    }
  }
}

/** Consecutive keys of one table, a record's worth at a time. */
function reportSlices(rows: readonly E2eeBackfillReportKey[]): FamilyKey[] {
  const slices: FamilyKey[] = [];
  let current: {
    table: string;
    ids: (string | number)[];
    last: string;
  } | null = null;
  for (const row of rows) {
    if (
      !current ||
      current.table !== row.table ||
      current.ids.length >= REPORT_ROWS_PER_RECORD
    ) {
      if (current) {
        slices.push({
          id: current.last,
          reports: { table: current.table, ids: current.ids }
        });
      }
      current = { table: row.table, ids: [], last: row.key };
    }
    current.ids.push(row.id);
    current.last = row.key;
  }
  if (current) {
    slices.push({
      id: current.last,
      reports: { table: current.table, ids: current.ids }
    });
  }
  return slices;
}

/** Copies one entity; returns the payload bytes copied, or null if gone. */
async function copyOne(
  deps: E2eeBackfillDeps,
  family: E2eeBackfillFamily,
  key: FamilyKey
): Promise<number | null> {
  switch (family) {
    case 'dr':
      return copyDevice(deps, key.id);
    case 'cv':
      return copyGroup(deps, key.id);
    case 'dv':
      return copyInbox(deps, key.id);
    case 'bl':
      return copyBlob(deps, key.blob!);
    case 'bk':
      return copyBackups(deps, key.id);
    case 'md':
      return copyReports(deps, key.reports!);
  }
}

async function copyReports(
  deps: E2eeBackfillDeps,
  reports: NonNullable<FamilyKey['reports']>
): Promise<number | null> {
  // The writer locks the inbox before it reads the rows, as the live path.
  const copied = await deps.run((connection, batch) =>
    deps.writers.moderationRowsChanged(batch, connection, {
      table: reports.table,
      where: { id: reports.ids }
    })
  );
  return copied ? 0 : null;
}

async function copyDevice(
  deps: E2eeBackfillDeps,
  device: string
): Promise<number | null> {
  return deps.run(async (connection, batch) => {
    const suites = await deps.db.lockDevice(device, connection);
    if (suites === null) return null;
    await deps.writers.deviceChanged(batch, connection, device);
    for (const ciphersuite of suites) {
      await deps.writers.lastResortChanged(batch, connection, {
        deviceKey: device,
        ciphersuite
      });
    }
    return 0;
  });
}

async function copyGroup(
  deps: E2eeBackfillDeps,
  group: string
): Promise<number | null> {
  const lastSeq = await deps.run(async (connection, batch) => {
    const seq = await deps.db.lockGroup(group, connection);
    if (seq === null) return null;
    await deps.writers.groupCreated(batch, connection, group, 'import');
    return seq;
  });
  if (lastSeq === null) return null;
  const seqs = await deps.db.itemSeqs(group, lastSeq);
  let bytes = 0;
  for (let start = 0; start < seqs.length; start += ITEMS_PER_TRANSACTION) {
    const slice = seqs.slice(start, start + ITEMS_PER_TRANSACTION);
    bytes += await deps.run((connection, batch) =>
      deps.writers.logItemsImported(batch, connection, { group, seqs: slice })
    );
  }
  return bytes;
}

async function copyInbox(
  deps: E2eeBackfillDeps,
  device: string
): Promise<number | null> {
  return deps.run(async (connection, batch) => {
    await deps.writers.inboxSnapshot(batch, connection, device);
    return 0;
  });
}

async function copyBlob(
  deps: E2eeBackfillDeps,
  blob: E2eeBackfillBlob
): Promise<number | null> {
  // Complete blobs no longer change; retention only deletes them.
  const chunks: Buffer[] = [];
  for (let index = 0; index < Number(blob.chunk_count); index++) {
    const data = await deps.blobChunk(blob, index);
    if (!data) return null;
    chunks.push(data);
  }
  return deps.run(async (connection, batch) => {
    if (!(await deps.db.lockBlob(blob.blob_id, connection))) return null;
    for (let index = 0; index < chunks.length; index++) {
      await deps.writers.blobChunkStored(batch, connection, {
        blobId: blob.blob_id,
        index,
        data: chunks[index]
      });
    }
    await deps.writers.blobCompleted(batch, connection, blob.blob_id);
    return chunks.reduce((sum, data) => sum + data.length, 0);
  });
}

async function copyBackups(
  deps: E2eeBackfillDeps,
  profileId: string
): Promise<number | null> {
  const chunks = await deps.run((connection) =>
    deps.db.lockBackups(profileId, connection)
  );
  let bytes = 0;
  for (const chunk of chunks) {
    const data = await deps.backupObject(chunk.objectKey);
    if (!data) continue;
    // Under the profile lock again: a chunk compacted away since is skipped.
    bytes += await deps.run(async (connection, batch) => {
      const current = await deps.db.lockBackups(profileId, connection);
      const still = current.some(
        (row) => row.backupId === chunk.backupId && row.seq === chunk.seq
      );
      if (!still) return 0;
      await deps.writers.backupsChanged(batch, connection, {
        profileId,
        appended: { backupId: chunk.backupId, seq: chunk.seq, data }
      });
      return data.length;
    });
  }
  await deps.run((connection, batch) =>
    deps.db.lockBackups(profileId, connection).then(() =>
      deps.writers.backupsChanged(batch, connection, {
        profileId,
        snapshot: true
      })
    )
  );
  return bytes;
}

function count(rows: { n?: unknown }[]): number {
  return Number(rows[0]?.n ?? 0);
}

function sum(rows: { bytes?: unknown }[]): number {
  return Number(rows[0]?.bytes ?? 0);
}

export class MysqlE2eeBackfillDb
  extends LazyDbAccessCompatibleService
  implements E2eeBackfillDb
{
  private exec<T>(
    sql: string,
    params: Record<string, unknown> = {},
    connection?: Conn
  ): Promise<T[]> {
    const options: DbQueryOptions = connection
      ? { wrappedConnection: connection }
      : { forcePool: DbPoolName.WRITE };
    return this.db.execute<T>(sql, params, options);
  }

  async volume(): Promise<E2eeBackfillVolume> {
    const sql = E2EE_BACKFILL_VOLUME_SQL;
    const items = await this.exec<{
      item_type: string;
      n: number;
      bytes: number;
    }>(sql.items);
    const of = (type: string) =>
      items.find((row) => row.item_type === type) ?? { n: 0, bytes: 0 };
    const welcomes = await this.exec<{ n: number; bytes: number }>(
      sql.welcomes
    );
    const blobs = await this.exec<{ n: number; bytes: number }>(sql.blobs);
    const chunks = await this.exec<{ n: number; bytes: number }>(
      sql.backupChunks
    );
    return {
      groups: count(await this.exec(sql.groups)),
      entries: Number(of('entry').n),
      entryBytes: Number(of('entry').bytes),
      messages: Number(of('message').n),
      messageBytes: Number(of('message').bytes),
      pendingWelcomes: count(welcomes),
      welcomeBytes: sum(welcomes),
      devices: count(await this.exec(sql.devices)),
      lastResortKeyPackages: count(await this.exec(sql.lastResort)),
      completeBlobs: count(blobs),
      blobBytes: sum(blobs),
      backups: count(await this.exec(sql.backups)),
      backupChunks: count(chunks),
      backupBytes: sum(chunks),
      reports: count(await this.exec(sql.reports)),
      messageReports: count(await this.exec(sql.messageReports)),
      reportAccess: count(await this.exec(sql.reportAccess)),
      moderationDecisions: count(await this.exec(sql.moderationDecisions))
    };
  }

  private async keys(
    sql: string,
    after: string,
    limit: number
  ): Promise<string[]> {
    const rows = await this.exec<{ k: string }>(sql, { after, limit });
    return rows.map((row) => row.k);
  }

  groups(after: string, limit: number) {
    return this.keys(
      `select group_handle as k from ${E2EE_GROUPS_TABLE}
       where group_handle > :after order by group_handle limit :limit`,
      after,
      limit
    );
  }

  devices(after: string, limit: number) {
    return this.keys(
      `select device_key as k from ${E2EE_DEVICES_TABLE}
       where device_key > :after order by device_key limit :limit`,
      after,
      limit
    );
  }

  inboxes(after: string, limit: number) {
    return this.keys(
      `select k from (
         select device_key as k from ${E2EE_WELCOME_DELIVERIES_TABLE}
         union
         select device_key as k from ${E2EE_GROUP_ROSTER_TABLE}
           where removal_kind = 'revoke'
         union
         select substring(wave, 4) as k from ${E2EE_STREAMS_TABLE}
           where wave like 'dv/%'
       ) inboxes
       where k > :after order by k limit :limit`,
      after,
      limit
    );
  }

  async completeBlobs(after: string, limit: number) {
    const rows = await this.exec<E2eeBackfillBlob>(
      `select blob_id, chunk_count, storage, storage_location
       from ${E2EE_BLOBS_TABLE}
       where complete = true and blob_id > :after
       order by blob_id limit :limit`,
      { after, limit }
    );
    return rows.map((row) => ({
      ...row,
      chunk_count: Number(row.chunk_count)
    }));
  }

  backupProfiles(after: string, limit: number) {
    return this.keys(
      `select distinct profile_id as k from ${E2EE_BACKUPS_TABLE}
       where profile_id > :after order by profile_id limit :limit`,
      after,
      limit
    );
  }

  async reportKeys(
    after: string,
    limit: number
  ): Promise<E2eeBackfillReportKey[]> {
    const [afterTable, ...rest] = after.split(':');
    const afterId = rest.join(':');
    const out: E2eeBackfillReportKey[] = [];
    const slices: {
      readonly letter: string;
      readonly table: string;
      readonly sql: (from: string) => { sql: string; from: unknown };
    }[] = [
      {
        letter: 'a',
        table: E2EE_REPORT_ACCESS_LOG_TABLE,
        sql: (from) => ({
          sql: `select id as k from ${E2EE_REPORT_ACCESS_LOG_TABLE}
                where id > :from order by id limit :limit`,
          from: from ? Number(from) : 0
        })
      },
      {
        letter: 'e',
        table: E2EE_REPORTS_TABLE,
        sql: (from) => ({
          sql: `select id as k from ${E2EE_REPORTS_TABLE}
                where id > :from order by id limit :limit`,
          from
        })
      },
      {
        letter: 'i',
        table: CONTENT_MODERATION_ITEMS_TABLE,
        sql: (from) => ({
          sql: `select id as k from ${CONTENT_MODERATION_ITEMS_TABLE}
                ${e2eeRecordWhere(
                  e2eeRecordTable(CONTENT_MODERATION_ITEMS_TABLE),
                  [E2EE_DECIDED_ITEM_SQL, 'id > :from']
                )}
                order by id limit :limit`,
          from
        })
      },
      {
        letter: 'r',
        table: CONTENT_MODERATION_REPORTS_TABLE,
        sql: (from) => ({
          sql: `select id as k from ${CONTENT_MODERATION_REPORTS_TABLE}
                ${e2eeRecordWhere(
                  e2eeRecordTable(CONTENT_MODERATION_REPORTS_TABLE),
                  ['id > :from']
                )}
                order by id limit :limit`,
          from
        })
      }
    ];
    for (const slice of slices) {
      if (out.length >= limit) break;
      if (after && slice.letter < afterTable) continue;
      const query = slice.sql(slice.letter === afterTable ? afterId : '');
      const rows = await this.exec<{ k: string | number }>(query.sql, {
        from: query.from,
        limit: limit - out.length
      });
      for (const row of rows) {
        out.push({
          key: `${slice.letter}:${row.k}`,
          table: slice.table,
          id: slice.letter === 'a' ? Number(row.k) : String(row.k)
        });
      }
    }
    return out;
  }

  async itemSeqs(group: string, throughSeq: number) {
    const rows = await this.exec<{ seq: number | string }>(
      `select seq from ${E2EE_LOG_TABLE}
       where group_handle = :group and seq <= :throughSeq order by seq`,
      { group, throughSeq }
    );
    return rows.map((row) => Number(row.seq));
  }

  async lockGroup(group: string, connection: Conn) {
    const rows = await this.exec<{ last_seq: number | string }>(
      `select last_seq from ${E2EE_GROUPS_TABLE}
       where group_handle = :group for update`,
      { group },
      connection
    );
    return rows[0] ? Number(rows[0].last_seq) : null;
  }

  async lockDevice(device: string, connection: Conn) {
    const rows = await this.exec<{ device_key: string }>(
      `select device_key from ${E2EE_DEVICES_TABLE}
       where device_key = :device for update`,
      { device },
      connection
    );
    if (!rows.length) return null;
    const suites = await this.exec<{ ciphersuite: number | string }>(
      `select distinct ciphersuite from ${E2EE_KEY_PACKAGES_TABLE}
       where device_key = :device and last_resort = true`,
      { device },
      connection
    );
    return suites.map((row) => Number(row.ciphersuite));
  }

  async lockBlob(blobId: string, connection: Conn) {
    const rows = await this.exec(
      `select blob_id from ${E2EE_BLOBS_TABLE}
       where blob_id = :blobId and complete = true for update`,
      { blobId },
      connection
    );
    return rows.length > 0;
  }

  async lockBackups(profileId: string, connection: Conn) {
    // The backup service serializes a profile's writes on its profile row.
    await this.exec(
      `select external_id from ${PROFILES_TABLE}
       where external_id = :profileId for update`,
      { profileId },
      connection
    );
    const rows = await this.exec<{
      backup_id: string;
      seq: number | string;
      object_key: string;
    }>(
      `select backup_id, seq, object_key from ${E2EE_BACKUP_CHUNKS_TABLE}
       where profile_id = :profileId order by backup_id, seq`,
      { profileId },
      connection
    );
    return rows.map((row) => ({
      backupId: row.backup_id,
      seq: Number(row.seq),
      objectKey: row.object_key
    }));
  }
}

export const mysqlE2eeBackfillDb = new MysqlE2eeBackfillDb(dbSupplier);
