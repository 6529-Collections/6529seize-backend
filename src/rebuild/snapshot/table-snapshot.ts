import { createHash } from 'node:crypto';
import { MysqlAdmin, Row } from '@/rebuild/stack/mysql-admin';

export interface TableSnapshot {
  readonly table: string;
  readonly rows: number;
  /** Over every row hash in order. */
  readonly digest: string;
  /** Per row: its primary key as JSON (or its hash when there is none). */
  readonly keys: string[];
  readonly hashes: string[];
}

export interface TableDiff {
  readonly table: string;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly same: boolean;
  /** Up to `limit` keys each: only before, only after, changed. */
  readonly missing: string[];
  readonly extra: string[];
  readonly changed: string[];
}

function canonicalValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function sortedKeys(object: Row): string[] {
  return Object.keys(object).sort((a, b) => a.localeCompare(b));
}

/** A row as JSON with sorted columns, leaving out `volatile` columns. */
export function canonicalRow(
  row: Row,
  volatile: ReadonlySet<string> = new Set()
): string {
  const result: Record<string, unknown> = {};
  for (const column of sortedKeys(row)) {
    if (!volatile.has(column)) result[column] = canonicalValue(row[column]);
  }
  return JSON.stringify(result);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hashes rows; rows without a primary key are ordered by their hash. */
export function snapshotRows(
  table: string,
  rows: readonly Row[],
  primaryKey: readonly string[],
  volatile: ReadonlySet<string> = new Set()
): TableSnapshot {
  let entries = rows.map((row) => {
    const hash = sha256(canonicalRow(row, volatile));
    const key = primaryKey.length
      ? JSON.stringify(primaryKey.map((column) => canonicalValue(row[column])))
      : hash;
    return { key, hash };
  });
  if (!primaryKey.length) {
    entries = entries.sort((a, b) => a.hash.localeCompare(b.hash));
  }
  return {
    table,
    rows: entries.length,
    digest: sha256(entries.map((entry) => entry.hash).join('\n')),
    keys: entries.map((entry) => entry.key),
    hashes: entries.map((entry) => entry.hash)
  };
}

export async function snapshotTable(
  admin: MysqlAdmin,
  database: string,
  table: string,
  volatileColumns: readonly string[] = []
): Promise<TableSnapshot> {
  const primaryKey = await admin.primaryKey(database, table);
  const rows = await admin.orderedRows(database, table, primaryKey);
  return snapshotRows(table, rows, primaryKey, new Set(volatileColumns));
}

/** Compares two snapshots of one table by key. */
export function diffSnapshots(
  before: TableSnapshot,
  after: TableSnapshot,
  limit = 20
): TableDiff {
  const index = (snapshot: TableSnapshot) =>
    new Map(snapshot.keys.map((key, i) => [key, snapshot.hashes[i]]));
  const a = index(before);
  const b = index(after);
  const missing = before.keys.filter((key) => !b.has(key));
  const extra = after.keys.filter((key) => !a.has(key));
  const changed = before.keys.filter(
    (key) => b.has(key) && b.get(key) !== a.get(key)
  );
  return {
    table: before.table,
    rowsBefore: before.rows,
    rowsAfter: after.rows,
    same: before.digest === after.digest,
    missing: missing.slice(0, limit),
    extra: extra.slice(0, limit),
    changed: changed.slice(0, limit)
  };
}
