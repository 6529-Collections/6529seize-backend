import { createHash } from 'node:crypto';
import { MysqlAdmin, Row, scopeFlag } from '@/rebuild/stack/mysql-admin';

export interface TableSnapshot {
  readonly table: string;
  readonly rows: number;
  /** Over every row hash in order. */
  readonly digest: string;
  /**
   * Per row: its row key as JSON (the declared rowKey, else the primary
   * key), or its hash when there is none.
   */
  readonly keys: string[];
  readonly hashes: string[];
  /**
   * Per volatile column scoped by a condition, in the entry's order: the
   * keys of the rows the condition matched, which leave the column out.
   */
  readonly scoped: { readonly column: string; readonly keys: string[] }[];
}

/**
 * A volatile column left out only of the rows its condition matches (an
 * SQL condition on the table's columns, as a plan's `where`).
 */
export interface ScopedVolatile {
  readonly column: string;
  readonly where: string;
}

/**
 * A row read with scope flags (see scopeFlag): the row without them, and
 * the scoped columns its flags leave out.
 */
export function unscoped(
  row: Row,
  scoped: readonly ScopedVolatile[]
): { row: Row; left: string[] } {
  if (!scoped.length) return { row, left: [] };
  const plain: Row = { ...row };
  const left: string[] = [];
  scoped.forEach(({ column }, i) => {
    const flag = plain[scopeFlag(i)];
    delete plain[scopeFlag(i)];
    if (Number(flag) === 1) left.push(column);
  });
  return { row: plain, left };
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
  /**
   * Up to `limit` keys of rows that changed only in a plan's columns
   * (`columns` on a plan), left out of `changed` and of `same`.
   */
  readonly plannedColumns: string[];
  /** How many rows changed only in a plan's columns. */
  readonly plannedColumnRows: number;
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
 * Hashes rows, keyed by `key`: the table's row key (its declared rowKey,
 * else its primary key). Rows without one are ordered by their hash. A key
 * with a volatile column (an auto-increment id the API never shows, which
 * a rebuild numbers anew) is no key: those rows match by their other
 * columns, like rows without one. A scoped volatile column (`scoped`, read
 * with its flags, see scopeFlag) is left out only of the rows its
 * condition matched.
 */
export function snapshotRows(
  table: string,
  rows: readonly Row[],
  key: readonly string[],
  volatile: ReadonlySet<string> = new Set(),
  scoped: readonly ScopedVolatile[] = []
): TableSnapshot {
  const keyed = key.some(
    (column) => volatile.has(column) || scoped.some((s) => s.column === column)
  )
    ? []
    : key;
  let entries = rows.map((row) => {
    const { row: plain, left } = unscoped(row, scoped);
    const hash = sha256(
      canonicalRow(
        plain,
        left.length ? new Set([...Array.from(volatile), ...left]) : volatile
      )
    );
    return {
      key: keyed.length
        ? JSON.stringify(keyed.map((column) => canonicalValue(plain[column])))
        : hash,
      hash,
      left
    };
  });
  if (!keyed.length) {
    entries = entries.sort((a, b) => a.hash.localeCompare(b.hash));
  }
  return {
    table,
    rows: entries.length,
    digest: sha256(entries.map((entry) => entry.hash).join('\n')),
    keys: entries.map((entry) => entry.key),
    hashes: entries.map((entry) => entry.hash),
    scoped: scoped.map(({ column }) => ({
      column,
      keys: entries
        .filter((entry) => entry.left.includes(column))
        .map((entry) => entry.key)
    }))
  };
}

/**
 * Snapshots a table's rows, keyed by `key` (see snapshotRows) and read in
 * its order. With `checkpoint`, only the rows holding the column's newest
 * value, as MySQL orders it (MAX), the row its readers take.
 */
export async function snapshotTable(
  admin: MysqlAdmin,
  database: string,
  table: string,
  volatileColumns: readonly string[] = [],
  checkpoint?: string,
  options: {
    readonly key?: readonly string[];
    readonly scoped?: readonly ScopedVolatile[];
  } = {}
): Promise<TableSnapshot> {
  const key = options.key ?? (await admin.primaryKey(database, table));
  const scoped = options.scoped ?? [];
  const rows = await admin.orderedRows(
    database,
    table,
    key,
    checkpoint,
    scoped.map((s) => s.where)
  );
  return snapshotRows(table, rows, key, new Set(volatileColumns), scoped);
}

/**
 * Per scoped volatile column: how many rows the condition matched before
 * and after, and how many rows on both sides it matched on one side only
 * (compared there, so they show as changed).
 */
export function scopeCounts(
  before: TableSnapshot,
  after: TableSnapshot
): { column: string; before: number; after: number; oneSide: number }[] {
  const keysBefore = new Set(before.keys);
  const keysAfter = new Set(after.keys);
  return before.scoped.map(({ column, keys }, i) => {
    const scopedBefore = new Set(keys);
    const scopedAfter = new Set(after.scoped[i]?.keys ?? []);
    const onlyBefore = Array.from(scopedBefore).filter(
      (key) => keysAfter.has(key) && !scopedAfter.has(key)
    ).length;
    const onlyAfter = Array.from(scopedAfter).filter(
      (key) => keysBefore.has(key) && !scopedBefore.has(key)
    ).length;
    return {
      column,
      before: keys.length,
      after: after.scoped[i]?.keys.length ?? 0,
      oneSide: onlyBefore + onlyAfter
    };
  });
}

/** How many times each key occurs. */
function counts(keys: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of keys) result.set(key, (result.get(key) ?? 0) + 1);
  return result;
}

/** Per key, how many more rows `before` holds than `after`. */
function goneCounts(
  before: TableSnapshot,
  after: TableSnapshot
): Map<string, number> {
  const countAfter = counts(after.keys);
  const result = new Map<string, number>();
  counts(before.keys).forEach((n, key) => {
    const gone = n - (countAfter.get(key) ?? 0);
    if (gone > 0) result.set(key, gone);
  });
  return result;
}

/**
 * The columns whose values differ between two versions of one row, in
 * name order, leaving out `volatile` ones.
 */
export function differingColumns(
  a: Row,
  b: Row,
  volatile: ReadonlySet<string> = new Set()
): string[] {
  const value = (row: Row, column: string) =>
    JSON.stringify(canonicalValue(row[column]) ?? null);
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .filter((column) => !volatile.has(column))
    .filter((column) => value(a, column) !== value(b, column))
    .sort((x, y) => (x < y ? -1 : Number(x > y)));
}

/** Keys on both sides whose rows' hashes differ, in `before`'s order. */
export function changedKeys(
  before: TableSnapshot,
  after: TableSnapshot
): string[] {
  const index = (snapshot: TableSnapshot) =>
    new Map(snapshot.keys.map((key, i) => [key, snapshot.hashes[i]]));
  const a = index(before);
  const b = index(after);
  return Array.from(counts(before.keys).keys()).filter(
    (key) => b.has(key) && b.get(key) !== a.get(key)
  );
}

/**
 * How many of the rows `keys` names (one key per row, as `planned` takes
 * them) are gone from `before` to `after`.
 */
export function goneRows(
  before: TableSnapshot,
  after: TableSnapshot,
  keys: readonly string[]
): number {
  const gone = goneCounts(before, after);
  let rows = 0;
  counts(keys).forEach((n, key) => {
    rows += Math.min(n, gone.get(key) ?? 0);
  });
  return rows;
}

/**
 * Compares two snapshots of one table, counting rows per key: rows
 * without a key are keyed by their hash, so identical ones share it. A
 * row only before that `planned` names (one key per planned row, repeated
 * for identical rows; one a later change rebuilds) is listed apart and
 * doesn't make the table differ; extra and changed rows always do, and so
 * does a row only before beyond the planned count of its key.
 */
export function diffSnapshots(
  before: TableSnapshot,
  after: TableSnapshot,
  limit = 20,
  planned: readonly string[] = [],
  /** Keys of rows on both sides that differ only in a plan's columns. */
  plannedColumns: ReadonlySet<string> = new Set()
): TableDiff {
  const plannedCount = counts(planned);
  const missing: string[] = [];
  const plannedGone: string[] = [];
  goneCounts(before, after).forEach((gone, key) => {
    const excused = Math.min(gone, plannedCount.get(key) ?? 0);
    for (let i = 0; i < gone; i += 1) {
      (i < excused ? plannedGone : missing).push(key);
    }
  });
  const extra: string[] = [];
  goneCounts(after, before).forEach((more, key) => {
    for (let i = 0; i < more; i += 1) extra.push(key);
  });
  const changedAtAll = changedKeys(before, after);
  const changed = changedAtAll.filter((key) => !plannedColumns.has(key));
  const columnsOnly = changedAtAll.filter((key) => plannedColumns.has(key));
  return {
    table: before.table,
    rowsBefore: before.rows,
    rowsAfter: after.rows,
    // With only planned rows gone, before less those rows is after, key
    // by key, so the row counts agree too.
    same:
      before.digest === after.digest ||
      (!missing.length && !extra.length && !changed.length),
    missing: missing.slice(0, limit),
    planned: plannedGone.slice(0, limit),
    plannedRows: plannedGone.length,
    plannedColumns: columnsOnly.slice(0, limit),
    plannedColumnRows: columnsOnly.length,
    extra: extra.slice(0, limit),
    changed: changed.slice(0, limit)
  };
}
