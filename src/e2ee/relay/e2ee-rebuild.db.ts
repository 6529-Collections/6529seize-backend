import {
  E2EE_BACKUPS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_STREAMS_TABLE
} from '@/constants/db-tables';
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
  e2eeRecordTable
} from '@/e2ee/relay/e2ee-record-tables';
import { E2eeRebuiltState } from '@/e2ee/relay/e2ee-rebuild';
import { E2eeStreamHead } from '@/e2ee/relay/e2ee-stream-store';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const INSERT_BATCH = 200;
const EXAMPLES = 5;

/** Columns a rebuild writes beyond the carried ones. */
const EXTRA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [E2EE_DEVICES_TABLE]: ['last_seen_at']
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

  /** Every row of a recorded table, as a rebuild would carry it. */
  async rows(table: string): Promise<Map<string, E2eeRow>> {
    const target = e2eeRecordTable(table);
    const where =
      table === E2EE_KEY_PACKAGES_TABLE ? 'where last_resort = true' : '';
    const raw = await this.exec<Record<string, unknown>>(
      `select ${e2eeRecordSelectList(target)} from ${table} ${where}`
    );
    return new Map(
      raw.map((item) => {
        const row = e2eeRecordRow(target, item);
        return [e2eeRecordKeyString(target, row), row];
      })
    );
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
       where ${clauses.join(' and ')}`,
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
  async backupProfiles(): Promise<string[]> {
    const rows = await this.exec<{ profile_id: string }>(
      `select distinct profile_id from ${E2EE_BACKUPS_TABLE}`
    );
    return rows.map((row) => row.profile_id);
  }

  async heads(): Promise<E2eeStreamHead[]> {
    const rows = await this.exec<{
      wave: string;
      head_pos: number | string;
      head_hash: string | null;
    }>(`select wave, head_pos, head_hash from ${E2EE_STREAMS_TABLE}`);
    return rows.map((row) => ({
      wave: row.wave,
      pos: Number(row.head_pos),
      hash: row.head_hash
    }));
  }

  /** Writes rebuilt rows into empty tables. */
  async insert(state: E2eeRebuiltState, now: number): Promise<void> {
    for (const [table, rows] of Array.from(state.tables.entries())) {
      const columns = [
        ...Object.keys(e2eeRecordTable(table).columns),
        ...(EXTRA_COLUMNS[table] ?? [])
      ];
      const list = Array.from(rows.values());
      for (let start = 0; start < list.length; start += INSERT_BATCH) {
        await this.insertBatch(
          table,
          columns,
          list.slice(start, start + INSERT_BATCH)
        );
      }
    }
    const heads = state.heads.map((head) => ({
      wave: head.wave,
      head_pos: head.pos,
      head_hash: head.hash,
      created_at: now,
      updated_at: now
    }));
    for (let start = 0; start < heads.length; start += INSERT_BATCH) {
      await this.insertBatch(
        E2EE_STREAMS_TABLE,
        ['wave', 'head_pos', 'head_hash', 'created_at', 'updated_at'],
        heads.slice(start, start + INSERT_BATCH)
      );
    }
  }

  private async insertBatch(
    table: string,
    columns: readonly string[],
    rows: readonly Readonly<Record<string, E2eeRowValue>>[]
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
    await this.exec(
      `insert into ${table} (${columns.join(', ')}) values ${values.join(', ')}`,
      params
    );
  }
}

export const e2eeRebuildDb = new E2eeRebuildDb(dbSupplier);
