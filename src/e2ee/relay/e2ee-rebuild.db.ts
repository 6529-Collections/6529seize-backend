import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_LOG_TABLE,
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_RECORD_ITEMS_TABLE,
  E2EE_RELAY_OUTBOX_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_STREAMS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE
} from '@/constants/db-tables';
import { E2EE_MODERATION_INBOX } from '@/e2ee/relay/e2ee-moderation-seal';
import { DbPoolName } from '@/db-query.options';
import {
  E2eeMissingBytes,
  E2eeRow,
  E2eeRowValue
} from '@/e2ee/relay/e2ee-record-container';
import {
  E2EE_RECORD_TABLES,
  e2eeRecordKeyString,
  e2eeRecordRow,
  e2eeRecordSelectList,
  E2EE_DECIDED_ITEM_SQL,
  e2eeRecordTable,
  e2eeRecordWhere
} from '@/e2ee/relay/e2ee-record-tables';
import type { E2eeRebuiltStream } from '@/e2ee/relay/e2ee-rebuild';
import { E2eeStreamHead } from '@/e2ee/relay/e2ee-stream-store';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

const INSERT_BATCH = 200;
const EXAMPLES = 5;

/** Columns a rebuild writes beyond the carried ones. */
const EXTRA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [E2EE_DEVICES_TABLE]: ['last_seen_at'],
  // The AI result of a moderation item, left to a rerun (outcome PENDING).
  [CONTENT_MODERATION_ITEMS_TABLE]: [
    'evidence',
    'outcome',
    'trigger',
    'evidence_expires_at',
    'version',
    'updated_at'
  ]
};

/**
 * Columns the side-by-side check does not compare: activity, where an
 * attachment's bytes are stored, and the bytes MySQL leaves empty when they
 * live in S3. The row sets and every other column must match.
 */
const UNCOMPARED: Readonly<Record<string, readonly string[]>> = {
  [E2EE_BLOBS_TABLE]: ['storage', 'storage_location'],
  [E2EE_BLOB_CHUNKS_TABLE]: ['data']
};

export interface E2eeTableComparison {
  readonly table: string;
  readonly rebuilt: number;
  readonly mysql: number;
  readonly missing: number;
  readonly extra: number;
  readonly changed: number;
  readonly examples: readonly string[];
}

function sqlValue(value: E2eeRowValue | undefined): unknown {
  if (value === undefined || value instanceof E2eeMissingBytes) return null;
  return value;
}

function sameValue(a: E2eeRowValue | undefined, b: E2eeRowValue | undefined) {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  }
  return (a ?? null) === (b ?? null);
}

/** Compares rebuilt rows with MySQL's, table by table. */
export function compareE2eeTables(
  table: string,
  rebuilt: Map<string, E2eeRow>,
  mysql: Map<string, E2eeRow>
): E2eeTableComparison {
  const skip = new Set(UNCOMPARED[table] ?? []);
  const columns = Object.keys(e2eeRecordTable(table).columns).filter(
    (column) => !skip.has(column)
  );
  const examples: string[] = [];
  let missing = 0;
  let changed = 0;
  for (const [key, row] of Array.from(mysql.entries())) {
    const other = rebuilt.get(key);
    if (!other) {
      missing++;
      if (examples.length < EXAMPLES) examples.push(`missing ${key}`);
      continue;
    }
    const different = columns.filter(
      (column) => !sameValue(row[column], other[column])
    );
    if (different.length) {
      changed++;
      if (examples.length < EXAMPLES) {
        examples.push(`changed ${key}: ${different.join(', ')}`);
      }
    }
  }
  const extra = Array.from(rebuilt.keys()).filter((key) => !mysql.has(key));
  examples.push(
    ...extra
      .slice(0, Math.max(0, EXAMPLES - examples.length))
      .map((key) => `extra ${key}`)
  );
  return {
    table,
    rebuilt: rebuilt.size,
    mysql: mysql.size,
    missing,
    extra: extra.length,
    changed,
    examples
  };
}

/** MySQL entities with no stream, by kind (the check's first slice). */
export interface E2eeCoverage {
  readonly groups: number;
  readonly devices: number;
  readonly inboxes: number;
  readonly blobs: number;
  readonly backups: number;
  readonly reports: number;
  readonly missing: number;
  readonly examples: readonly string[];
}

/** Reads and writes the delivery service's tables for a rebuild. */
export class E2eeRebuildDb extends LazyDbAccessCompatibleService {
  private exec<T>(sql: string, params: Record<string, unknown> = {}) {
    return this.db.execute<T>(sql, params, { forcePool: DbPoolName.WRITE });
  }

  /** Row counts of every rebuilt table, and of the stream heads. */
  async counts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of [
      ...Object.keys(E2EE_RECORD_TABLES),
      E2EE_STREAMS_TABLE
    ]) {
      const [row] = await this.exec<{ cnt: number | string }>(
        `select count(*) as cnt from ${table}`
      );
      counts[table] = Number(row?.cnt ?? 0);
    }
    return counts;
  }

  /** Rows of a table matching every column given (arrays match any). */
  async rowsWhere(
    table: string,
    where: Readonly<Record<string, E2eeRowValue | readonly E2eeRowValue[]>>
  ): Promise<Map<string, E2eeRow>> {
    const target = e2eeRecordTable(table);
    if (Object.values(where).some((v) => Array.isArray(v) && !v.length)) {
      return new Map();
    }
    const params: Record<string, unknown> = {};
    const clauses = Object.entries(where).map(([column, value], index) => {
      if (!(column in target.columns)) {
        throw new Error(`${table} has no column ${column}`);
      }
      params[`w${index}`] = value;
      if (Array.isArray(value)) return `${column} in (:w${index})`;
      return value === null ? `${column} is null` : `${column} = :w${index}`;
    });
    const raw = await this.exec<Record<string, unknown>>(
      `select ${e2eeRecordSelectList(target)} from ${table}
       ${e2eeRecordWhere(target, clauses)}`,
      params
    );
    return new Map(
      raw.map((item) => {
        const row = e2eeRecordRow(target, item);
        return [e2eeRecordKeyString(target, row), row];
      })
    );
  }

  /** Stream heads after `afterWave`, in wave order (the check's cursor). */
  async headsPage(afterWave: string, limit: number): Promise<E2eeStreamHead[]> {
    const rows = await this.exec<{
      wave: string;
      head_pos: number | string;
      head_hash: string | null;
    }>(
      `select wave, head_pos, head_hash from ${E2EE_STREAMS_TABLE}
       where wave > :afterWave order by wave limit :limit`,
      { afterWave, limit }
    );
    return rows.map((row) => ({
      wave: row.wave,
      pos: Number(row.head_pos),
      hash: row.head_hash
    }));
  }

  /** Profiles with backups, for the bk stream owner of each. */
  /**
   * A stream's records still in the outbox after position `afterPos`: what
   * MySQL committed that some relay does not hold yet.
   */
  async outboxAfter(wave: string, afterPos: number): Promise<number> {
    const [row] = await this.exec<{ n: number | string }>(
      `select count(*) as n from ${E2EE_RELAY_OUTBOX_TABLE}
       where wave = :wave and pos > :afterPos`,
      { wave, afterPos }
    );
    return Number(row?.n ?? 0);
  }

  async backupProfiles(): Promise<string[]> {
    const rows = await this.exec<{ profile_id: string }>(
      `select distinct profile_id from ${E2EE_BACKUPS_TABLE}`
    );
    return rows.map((row) => row.profile_id);
  }

  /**
   * MySQL entities with no stream at all (the per-stream check only sees
   * streams that have a head), with a few examples.
   */
  async coverage(): Promise<E2eeCoverage> {
    const reportScope = e2eeRecordWhere(
      e2eeRecordTable(CONTENT_MODERATION_REPORTS_TABLE)
    );
    const itemScope = e2eeRecordWhere(
      e2eeRecordTable(CONTENT_MODERATION_ITEMS_TABLE),
      [E2EE_DECIDED_ITEM_SQL]
    );
    const checks: Record<
      keyof Omit<E2eeCoverage, 'missing' | 'examples'>,
      string
    > = {
      groups: `select g.group_handle as k from ${E2EE_GROUPS_TABLE} g
        left join ${E2EE_STREAMS_TABLE} s on s.wave = concat('cv/', g.group_handle)
        where s.wave is null`,
      devices: `select d.device_key as k from ${E2EE_DEVICES_TABLE} d
        left join ${E2EE_STREAMS_TABLE} s on s.wave = concat('dr/', d.device_key)
        where s.wave is null`,
      inboxes: `select distinct w.device_key as k
        from ${E2EE_WELCOME_DELIVERIES_TABLE} w
        left join ${E2EE_STREAMS_TABLE} s on s.wave = concat('dv/', w.device_key)
        where s.wave is null`,
      blobs: `select b.blob_id as k from ${E2EE_BLOBS_TABLE} b
        left join ${E2EE_STREAMS_TABLE} s on s.wave = concat('bl/', b.blob_id)
        where b.complete = true and s.wave is null`,
      backups: `select distinct b.profile_id as k from ${E2EE_BACKUPS_TABLE} b
        left join ${E2EE_STREAMS_TABLE} s on s.wave = concat('bk/0x',
          sha2(concat('6529.io e2ee backups ', b.profile_id), 256))
        where s.wave is null`,
      reports: `select 'reports' as k from dual
        where not exists (select 1 from ${E2EE_STREAMS_TABLE}
                          where wave = :inbox)
          and (exists (select 1 from ${CONTENT_MODERATION_REPORTS_TABLE} ${reportScope})
            or exists (select 1 from ${E2EE_REPORTS_TABLE})
            or exists (select 1 from ${E2EE_REPORT_ACCESS_LOG_TABLE})
            or exists (select 1 from ${CONTENT_MODERATION_ITEMS_TABLE}
              ${itemScope}))`
    };
    const counts: Record<string, number> = {};
    const examples: string[] = [];
    let missing = 0;
    for (const [name, sql] of Object.entries(checks)) {
      const rows = await this.exec<{ k: string }>(
        `select count(*) as cnt, min(k) as k from (${sql}) missing`,
        { inbox: `md/${E2EE_MODERATION_INBOX}` }
      );
      const count = Number((rows[0] as { cnt?: unknown })?.cnt ?? 0);
      counts[name] = count;
      missing += count;
      if (count && examples.length < EXAMPLES) {
        examples.push(`${name}: ${String(rows[0]?.k)}`);
      }
    }
    return {
      ...(counts as Omit<E2eeCoverage, 'missing' | 'examples'>),
      missing,
      examples
    };
  }

  /** Write mode: streams a relay listed, as placeholder heads at 0. */
  async addPendingStreams(waves: readonly string[], now: number) {
    for (let start = 0; start < waves.length; start += INSERT_BATCH) {
      const slice = waves.slice(start, start + INSERT_BATCH);
      if (!slice.length) continue;
      await this.exec(
        `insert ignore into ${E2EE_STREAMS_TABLE}
           (wave, head_pos, head_hash, created_at, updated_at)
         values ${slice.map((_, i) => `(:w${i}, 0, null, :now, :now)`).join(', ')}`,
        Object.fromEntries([
          ['now', now],
          ...slice.map((wave, i) => [`w${i}`, wave])
        ])
      );
    }
  }

  /**
   * Write mode: streams not yet written, devices first (revocations are
   * read from them) and inboxes after groups (a revocation's roster rows
   * replace the groups' own), the moderators' inbox last.
   */
  async pendingStreams(limit: number): Promise<string[]> {
    const rows = await this.exec<{ wave: string }>(
      `select wave from ${E2EE_STREAMS_TABLE} where head_pos = 0
       order by field(substring_index(wave, '/', 1),
                      'dr', 'cv', 'dv', 'bl', 'bk', 'md'), wave
       limit :limit`,
      { limit }
    );
    return rows.map((row) => row.wave);
  }

  async revokedDevices(): Promise<Set<string>> {
    const rows = await this.exec<{ device_key: string }>(
      `select device_key from ${E2EE_DEVICES_TABLE} where revoked_at is not null`
    );
    return new Set(rows.map((row) => row.device_key));
  }

  /**
   * Write mode: one rebuilt stream's rows (insert, or replace a row another
   * stream wrote) and its head, in one transaction. A stream with no
   * usable record loses its placeholder head.
   */
  async writeStream(stream: E2eeRebuiltStream, now: number): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      for (const [table, rows] of Array.from(stream.tables.entries())) {
        const columns = [
          ...Object.keys(e2eeRecordTable(table).columns),
          ...(EXTRA_COLUMNS[table] ?? [])
        ];
        const list = Array.from(rows.values());
        for (let start = 0; start < list.length; start += INSERT_BATCH) {
          await this.upsert(
            table,
            columns,
            list.slice(start, start + INSERT_BATCH),
            connection
          );
        }
      }
      for (const item of stream.items) {
        for (const key of item.keys) {
          await this.db.execute(
            `insert ignore into ${E2EE_RECORD_ITEMS_TABLE}
               (wave, pos, item_key, event_id, created_at)
             values (:wave, :pos, :key, :eventId, :now)`,
            {
              wave: stream.wave,
              pos: item.pos,
              key,
              eventId: item.eventId,
              now
            },
            { wrappedConnection: connection }
          );
        }
      }
      await this.db.execute(
        stream.head
          ? `update ${E2EE_STREAMS_TABLE}
             set head_pos = :pos, head_hash = :hash, updated_at = :now
             where wave = :wave`
          : `delete from ${E2EE_STREAMS_TABLE} where wave = :wave`,
        {
          wave: stream.wave,
          pos: stream.head?.pos ?? 0,
          hash: stream.head?.hash ?? null,
          now
        },
        { wrappedConnection: connection }
      );
    });
  }

  /** Write mode, last: each device's activity is its latest log item. */
  async deriveActivity(): Promise<void> {
    await this.exec(
      `update ${E2EE_DEVICES_TABLE} d set d.last_seen_at = (
         select max(l.created_at) from ${E2EE_LOG_TABLE} l
         where l.sender_device_key = d.device_key)`
    );
  }

  private async upsert(
    table: string,
    columns: readonly string[],
    rows: readonly Readonly<Record<string, E2eeRowValue>>[],
    connection: ConnectionWrapper<unknown>
  ): Promise<void> {
    if (!rows.length) return;
    const params: Record<string, unknown> = {};
    const values = rows.map((row, rowIndex) => {
      const names = columns.map((column, columnIndex) => {
        const name = `v${rowIndex}_${columnIndex}`;
        params[name] = sqlValue(row[column]);
        return `:${name}`;
      });
      return `(${names.join(', ')})`;
    });
    // Quoted: moderation items have a column named `trigger`.
    const quoted = columns.map((column) => `\`${column}\``);
    await this.db.execute(
      `insert into ${table} (${quoted.join(', ')}) values ${values.join(', ')}
       on duplicate key update ${quoted
         .map((name) => `${name} = values(${name})`)
         .join(', ')}`,
      params,
      { wrappedConnection: connection }
    );
  }
}

export const e2eeRebuildDb = new E2eeRebuildDb(dbSupplier);
