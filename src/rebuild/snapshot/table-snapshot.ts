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
  /**
   * Up to `limit` keys of rows only before that are planned (a later
   * change rebuilds them), left out of `missing` and of `same`.
   */
  readonly planned: string[];
  /** How many rows only before are planned. */
  readonly plannedRows: number;
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

/**
 * Hashes rows; rows without a primary key are ordered by their hash. A
 * primary key with a volatile column (an auto-increment id the API never
 * shows, which a rebuild numbers anew) is no key: those rows match by
 * their other columns, like rows without one.
 */
export function snapshotRows(
  table: string,
  rows: readonly Row[],
  primaryKey: readonly string[],
  volatile: ReadonlySet<string> = new Set()
): TableSnapshot {
  const key = primaryKey.some((column) => volatile.has(column))
    ? []
    : primaryKey;
  let entries = rows.map((row) => {
    const hash = sha256(canonicalRow(row, volatile));
    return {
      key: key.length
        ? JSON.stringify(key.map((column) => canonicalValue(row[column])))
        : hash,
      hash
    };
  });
  if (!key.length) {
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

/**
 * Snapshots a table's rows. With `checkpoint`, only the rows holding the
 * column's newest value, as MySQL orders it (MAX), the row its readers
 * take.
 */
export async function snapshotTable(
  admin: MysqlAdmin,
  database: string,
  table: string,
  volatileColumns: readonly string[] = [],
  checkpoint?: string
): Promise<TableSnapshot> {
  const primaryKey = await admin.primaryKey(database, table);
  const rows = await admin.orderedRows(database, table, primaryKey, checkpoint);
  return snapshotRows(table, rows, primaryKey, new Set(volatileColumns));
}

/**
 * Compares two snapshots of one table by key. A row only before whose key
 * is `planned` (one a later change rebuilds) is listed apart and doesn't
 * make the table differ; extra and changed rows always do.
 */
export function diffSnapshots(
  before: TableSnapshot,
  after: TableSnapshot,
  limit = 20,
  planned: ReadonlySet<string> = new Set()
): TableDiff {
  const index = (snapshot: TableSnapshot) =>
    new Map(snapshot.keys.map((key, i) => [key, snapshot.hashes[i]]));
  const a = index(before);
  const b = index(after);
  const gone = before.keys.filter((key) => !b.has(key));
  const missing = gone.filter((key) => !planned.has(key));
  const plannedGone = gone.filter((key) => planned.has(key));
  const extra = after.keys.filter((key) => !a.has(key));
  const changed = before.keys.filter(
    (key) => b.has(key) && b.get(key) !== a.get(key)
  );
  return {
    table: before.table,
    rowsBefore: before.rows,
    rowsAfter: after.rows,
    same:
      before.digest === after.digest ||
      // Only planned rows gone: the same once they are left out. Row
      // counts too, since rows without a key match by hash.
      (plannedGone.length > 0 &&
        !missing.length &&
        !extra.length &&
        !changed.length &&
        before.rows - plannedGone.length === after.rows),
    missing: missing.slice(0, limit),
    planned: plannedGone.slice(0, limit),
    plannedRows: plannedGone.length,
    extra: extra.slice(0, limit),
    changed: changed.slice(0, limit)
  };
}
