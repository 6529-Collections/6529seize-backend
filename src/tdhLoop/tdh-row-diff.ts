import { EntityManager, EntityMetadata, ObjectLiteral } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

/**
 * Changed-rows writes for partial TDH persistence. A partial write computes
 * every row of a table (other groups' rows are only re-ranked), but few
 * change. Each computed row is compared, column by column, with the stored
 * row as MySQL would store the computed values; rows that match are not
 * written. The comparison is conservative: when the stored form of a value
 * cannot be known exactly (an undefined value without a NULL default, a
 * fractional date, an unknown column type), the row counts as changed.
 *
 * Two kinds of column are not compared like the rest (`RowDiffColumns`): a
 * column the same transaction sets again for every row afterwards, whose
 * written value never survives, and a column that takes a new value on every
 * run (a computation time), which a row that is otherwise unchanged gets
 * through a narrow update instead of a full-row upsert.
 *
 * JSON doubles: MySQL rounds some doubles when it stores JSON, with no fixed
 * number of digits (27.900000000000002 is stored as 27.9, 1234.5678901234567
 * as 1234.567890123457, while 0.30000000000000004 is kept). What is read back
 * is what is stored: writing the read-back value stores the same bytes, and
 * JSON_EXTRACT comparisons see the read-back value too (MySQL 8.0, Aurora
 * 8.0.42). So a row whose computed JSON equals what is read back is left as
 * it is. No current SQL reads the numbers inside these JSON columns.
 */

const INTEGER_TYPES = new Set([
  'int',
  'integer',
  'bigint',
  'smallint',
  'tinyint',
  'mediumint'
]);
const NUMBER_TYPES = new Set(['double', 'float', 'real', 'decimal', 'numeric']);
const TEXT_TYPES = new Set(['varchar', 'char', 'text', 'longtext', 'tinytext']);
const DATE_TYPES = new Set(['datetime', 'timestamp']);
const JSON_TYPES = new Set(['json', 'simple-json']);

/** A stored JSON value that could not be parsed: nothing equals it. */
const UNPARSABLE = Symbol('unparsable');

/** Whether writing `computed` would leave `stored` as it is. */
type ColumnEquals = (computed: unknown, stored: unknown) => boolean;

/**
 * The integer MySQL stores for a number written to an integer column: the
 * driver sends its shortest decimal form, which MySQL rounds half away from
 * zero.
 */
function storedInteger(value: number): number {
  return Number.isInteger(value)
    ? value
    : Math.sign(value) * Math.round(Math.abs(value));
}

function integerEquals(computed: unknown, stored: unknown): boolean {
  const number = Number(computed);
  return Number.isFinite(number) && storedInteger(number) === Number(stored);
}

function numberEquals(computed: unknown, stored: unknown): boolean {
  const number = Number(computed);
  return Number.isFinite(number) && number === Number(stored);
}

function textEquals(computed: unknown, stored: unknown): boolean {
  return String(computed) === String(stored);
}

function dateMillis(value: unknown): number | null {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') {
    date = new Date(
      value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
    );
  }
  const millis = date?.getTime();
  return millis === undefined || Number.isNaN(millis) ? null : millis;
}

function dateEquals(computed: unknown, stored: unknown): boolean {
  const millis = dateMillis(computed);
  // datetime(0) rounds fractional seconds: only whole seconds are exact.
  return (
    millis !== null && millis % 1000 === 0 && millis === dateMillis(stored)
  );
}

/** As JSON.stringify serializes it: undefined and functions are dropped. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

/**
 * Whether `computed`, serialized as JSON, equals the parsed `stored` value.
 * Object key order does not matter (MySQL's JSON type reorders keys).
 */
function jsonValueEquals(computed: unknown, stored: unknown): boolean {
  if (computed === stored) return true;
  if (typeof computed === 'number' && !Number.isFinite(computed)) {
    return stored === null; // JSON.stringify writes NaN and Infinity as null
  }
  if (
    computed === null ||
    stored === null ||
    typeof computed !== 'object' ||
    typeof stored !== 'object'
  ) {
    return false;
  }
  const toJson = (computed as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === 'function') {
    return jsonValueEquals(toJson.call(computed), stored);
  }
  if (Array.isArray(computed)) {
    if (!Array.isArray(stored) || computed.length !== stored.length) {
      return false;
    }
    return computed.every((item, i) =>
      jsonValueEquals(isOmitted(item) ? null : item, stored[i])
    );
  }
  if (Array.isArray(stored)) return false;
  const storedRecord = stored as Record<string, unknown>;
  const computedRecord = computed as Record<string, unknown>;
  let keys = 0;
  for (const key of Object.keys(computedRecord)) {
    const item = computedRecord[key];
    if (isOmitted(item)) continue;
    keys++;
    if (
      !Object.prototype.hasOwnProperty.call(storedRecord, key) ||
      !jsonValueEquals(item, storedRecord[key])
    ) {
      return false;
    }
  }
  return keys === Object.keys(storedRecord).length;
}

function jsonEquals(computed: unknown, stored: unknown): boolean {
  if (stored === UNPARSABLE) return false;
  let value = computed;
  if (typeof computed === 'string') {
    try {
      value = JSON.parse(computed);
    } catch {
      return false;
    }
  }
  return jsonValueEquals(value, stored);
}

function columnEqualsFor(column: ColumnMetadata): ColumnEquals {
  const type = String(column.type).toLowerCase();
  let equals: ColumnEquals = () => false;
  if (INTEGER_TYPES.has(type)) equals = integerEquals;
  else if (NUMBER_TYPES.has(type)) equals = numberEquals;
  else if (TEXT_TYPES.has(type)) equals = textEquals;
  else if (DATE_TYPES.has(type)) equals = dateEquals;
  else if (JSON_TYPES.has(type)) equals = jsonEquals;
  // Written as DEFAULT: known only for a nullable column without one.
  const undefinedIsNull = column.isNullable && column.default === undefined;
  return (computed, stored) => {
    if (computed === undefined) return undefinedIsNull && stored === null;
    if (computed === null || stored === null || stored === undefined) {
      return computed === null && stored === null;
    }
    return equals(computed, stored);
  };
}

type EntityValue = (row: ObjectLiteral) => unknown;

/** A plain property read where the column is not embedded (much faster). */
function entityValueFor(column: ColumnMetadata): EntityValue {
  if (column.embeddedMetadata) return (row) => column.getEntityValue(row);
  const property = column.propertyName;
  return (row) => row[property];
}

/** How to compare and key one table's rows, built once per table. */
type TablePlan = {
  readonly columns: ColumnMetadata[];
  readonly equals: ColumnEquals[];
  readonly isJson: boolean[];
  readonly entityValues: EntityValue[];
  readonly databaseNames: string[];
  /** Indexes into `columns` of the primary columns. */
  readonly primary: number[];
};

const plans = new WeakMap<EntityMetadata, TablePlan>();

function planFor(metadata: EntityMetadata): TablePlan {
  let plan = plans.get(metadata);
  if (!plan) {
    const columns = metadata.columns;
    plan = {
      columns,
      equals: columns.map(columnEqualsFor),
      isJson: columns.map((column) =>
        JSON_TYPES.has(String(column.type).toLowerCase())
      ),
      entityValues: columns.map(entityValueFor),
      databaseNames: columns.map((column) => column.databaseName),
      primary: metadata.primaryColumns.map((column) => columns.indexOf(column))
    };
    plans.set(metadata, plan);
  }
  return plan;
}

const SEPARATOR = '\u0000';

/** MySQL compares these keys case-insensitively (ci collations). */
function rowKey(plan: TablePlan, valueAt: (i: number) => unknown) {
  let key = '';
  for (const i of plan.primary) {
    key += String(valueAt(i)).toLowerCase() + SEPARATOR;
  }
  return key;
}

/** Stored rows by key: each row's column values, in the plan's order. */
export type StoredRows = Map<string, unknown[]>;

/**
 * Entity-shaped rows as stored now, copied (JSON values deeply), so a later
 * in-place change to the same objects (ranking does that) is still seen.
 */
export function snapshotRows(
  metadata: EntityMetadata,
  rows: readonly ObjectLiteral[]
): StoredRows {
  const plan = planFor(metadata);
  const stored: StoredRows = new Map();
  for (const row of rows) {
    const values = plan.entityValues.map((valueOf, i) => {
      const value = valueOf(row);
      return plan.isJson[i] && value !== null && typeof value === 'object'
        ? structuredClone(value)
        : value;
    });
    stored.set(
      rowKey(plan, (i) => values[i]),
      values
    );
  }
  return stored;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return UNPARSABLE;
  }
}

/**
 * The stored rows of `metadata`'s table (optionally only those whose
 * `filter.column` equals `filter.value`), read on the
 * caller's transaction so they match what it writes against: a locking read
 * (`for share`), which sees the latest committed rows and keeps them locked
 * until the caller commits, as overwriting every row did. A concurrent writer
 * (a full rewrite, a rerun) waits for the partial write. The rows are
 * streamed, so each driver row is dropped once its values are kept: a table
 * is never held twice in memory.
 */
export async function readStoredRows(
  manager: EntityManager,
  metadata: EntityMetadata,
  filter?: { readonly column: string; readonly value: unknown }
): Promise<StoredRows> {
  const plan = planFor(metadata);
  const stored: StoredRows = new Map();
  const keep = (row: ObjectLiteral) => {
    const values = plan.databaseNames.map((name, i) =>
      plan.isJson[i] ? parsedJson(row[name]) : row[name]
    );
    stored.set(
      rowKey(plan, (i) => values[i]),
      values
    );
  };
  const name = (identifier: string) => `\`${identifier.replace(/`/g, '``')}\``;
  const sql = `select * from ${name(metadata.tableName)}${filter ? ` where ${name(filter.column)} = ?` : ''}`;
  const params = filter ? [filter.value] : [];
  const queryRunner = manager.queryRunner;
  if (!queryRunner) {
    // Outside a transaction: nothing to stream on or hold locks for, so the
    // whole result is buffered. Every partial write runs in a transaction.
    const rows: ObjectLiteral[] = await manager.query(sql, params);
    rows.forEach(keep);
    return stored;
  }
  const stream = await queryRunner.stream(`${sql} for share`, params);
  await new Promise<void>((resolve, reject) => {
    let failure: unknown = null;
    stream.on('data', (row: ObjectLiteral) => {
      if (failure !== null) return; // drain, so the connection stays usable
      try {
        keep(row);
      } catch (error) {
        failure = error;
      }
    });
    stream.on('error', reject);
    stream.on('end', () => (failure === null ? resolve() : reject(failure)));
  });
  return stored;
}

/** Columns of one table that a partial write does not compare as values. */
export type RowDiffColumns = {
  /**
   * Set again for every row later in the same transaction, from other
   * tables: the value written never survives, so it is not compared.
   */
  readonly recomputed?: readonly string[];
  /**
   * Takes a new value on every run. A row that differs from the stored row
   * only here is refreshed: this column alone is updated.
   */
  readonly refreshed?: string;
};

export type RowWrites<Entity> = {
  /** Rows to upsert in full: new, changed, or in the delete scope. */
  readonly upserts: Entity[];
  /** Rows that differ from the stored row only in the refreshed column. */
  readonly refreshes: Entity[];
};

function columnIndex(
  plan: TablePlan,
  metadata: EntityMetadata,
  propertyName: string
): number {
  const index = plan.columns.findIndex(
    (column) => column.propertyName === propertyName
  );
  if (index < 0 || plan.primary.includes(index)) {
    throw new Error(
      `${metadata.tableName}: ${propertyName} is not a non-key column`
    );
  }
  return index;
}

/**
 * The rows a partial write must send: every row it rewrote in full (its
 * delete scope, deleted just before), and any other row that is new or
 * differs from the stored one; rows that differ only in the refreshed column
 * are returned apart. The rest are already stored as they are.
 */
export function rowsToWrite<Entity extends ObjectLiteral>(
  metadata: EntityMetadata,
  rows: readonly Entity[],
  stored: StoredRows,
  isRewritten: (row: Entity) => boolean,
  { recomputed = [], refreshed }: RowDiffColumns = {}
): RowWrites<Entity> {
  const plan = planFor(metadata);
  const skipped = new Set(
    recomputed.map((name) => columnIndex(plan, metadata, name))
  );
  const refreshedAt =
    refreshed === undefined ? -1 : columnIndex(plan, metadata, refreshed);
  const compared = plan.columns.map((_, i) => i).filter((i) => !skipped.has(i));
  const upserts: Entity[] = [];
  const refreshes: Entity[] = [];
  for (const row of rows) {
    const current = isRewritten(row)
      ? undefined
      : stored.get(rowKey(plan, (i) => plan.entityValues[i](row)));
    if (!current) {
      upserts.push(row);
      continue;
    }
    let changed = false;
    let refresh = false;
    for (const i of compared) {
      if (plan.equals[i](plan.entityValues[i](row), current[i])) continue;
      if (i !== refreshedAt) {
        changed = true;
        break;
      }
      refresh = true;
    }
    if (changed) upserts.push(row);
    else if (refresh) refreshes.push(row);
  }
  return { upserts, refreshes };
}
