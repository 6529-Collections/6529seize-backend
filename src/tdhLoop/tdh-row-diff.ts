import * as crypto from 'crypto';
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
 * Rows in the write's scope (its affected wallets or replaced consolidation
 * keys), which the full-row path deleted and inserted again, are compared
 * too: a stored scope row is deleted only when its computed row differs or
 * is gone, so writing unchanged inputs again sends nothing.
 *
 * Each value is reduced to a canonical text that two values share exactly
 * when writing one would leave the other as stored, and a stored row is kept
 * only as a digest (SHA-256) of its canonical texts, so a table's stored rows
 * take little memory.
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

/** SQL NULL. */
const NULL = '\u0001';
/** A computed value whose stored form cannot be known: no stored value has it. */
const UNKNOWN = '\u0002';
/** A stored value no computed value equals (missing, or unparsable JSON). */
const NEVER = '\u0003';

/** A stored JSON value that could not be parsed. */
const UNPARSABLE = Symbol('unparsable');

type Canonical = (value: unknown) => string;

/**
 * A column's canonical texts: a computed value and a stored value have the
 * same text exactly when writing the computed one leaves the stored one as
 * it is.
 */
type ColumnCanonicals = {
  readonly computed: Canonical;
  readonly stored: Canonical;
};

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

/** As JSON.stringify serializes it: undefined and functions are dropped. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

/** Whether JavaScript orders a key as an array index (first, numerically). */
function isIndexKey(key: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4294967295;
}

/**
 * The key order of a stored JSON object as read back: MySQL orders keys by
 * length, then bytewise, and JSON.parse then puts index-like keys first, in
 * numeric order.
 */
function storedKeyOrder(a: string, b: string): number {
  const aIndex = isIndexKey(a);
  if (aIndex !== isIndexKey(b)) return aIndex ? -1 : 1;
  if (aIndex) return Number(a) - Number(b);
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A computed JSON value as MySQL stores it, in the text JSON.stringify gives
 * the value MySQL reads back (`storedJson`): object keys in the order they
 * are read back in (`storedKeyOrder`); undefined and functions dropped from
 * objects and null in arrays; NaN and Infinity null; toJSON applied. A value
 * JSON cannot hold (a bigint, a symbol) is UNKNOWN, which no stored text
 * contains. If MySQL ever ordered keys differently, rows would only be
 * written when they need not be, never skipped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      return UNKNOWN;
  }
  const toJson = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === 'function') return canonicalJson(toJson.call(value));
  if (Array.isArray(value)) {
    let text = '[';
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (i > 0) text += ',';
      text += isOmitted(item) ? 'null' : canonicalJson(item);
    }
    return `${text}]`;
  }
  const record = value as Record<string, unknown>;
  let text = '{';
  let first = true;
  for (const key of Object.keys(record).sort(storedKeyOrder)) {
    const item = record[key];
    if (isOmitted(item)) continue;
    if (!first) text += ',';
    first = false;
    text += `${JSON.stringify(key)}:${canonicalJson(item)}`;
  }
  return `${text}}`;
}

/**
 * A stored JSON value as read (parsed from MySQL's text, so its keys are in
 * MySQL's order), in the same text as `canonicalJson`.
 */
export function storedJson(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return UNPARSABLE;
  }
}

function typedCanonicals(type: string): ColumnCanonicals {
  if (INTEGER_TYPES.has(type)) {
    return {
      computed: (value) => {
        const number = Number(value);
        return Number.isFinite(number) ? `i${storedInteger(number)}` : UNKNOWN;
      },
      stored: (value) => `i${Number(value)}`
    };
  }
  if (NUMBER_TYPES.has(type)) {
    return {
      computed: (value) => {
        const number = Number(value);
        return Number.isFinite(number) ? `n${number}` : UNKNOWN;
      },
      stored: (value) => `n${Number(value)}`
    };
  }
  if (TEXT_TYPES.has(type)) {
    return {
      computed: (value) => `t${String(value)}`,
      stored: (value) => `t${String(value)}`
    };
  }
  if (DATE_TYPES.has(type)) {
    return {
      // datetime(0) rounds fractional seconds: only whole seconds are exact.
      computed: (value) => {
        const millis = dateMillis(value);
        return millis !== null && millis % 1000 === 0 ? `d${millis}` : UNKNOWN;
      },
      stored: (value) => {
        const millis = dateMillis(value);
        return millis === null ? NEVER : `d${millis}`;
      }
    };
  }
  if (JSON_TYPES.has(type)) {
    return {
      computed: (value) => {
        const parsed = parsedJson(value);
        return parsed === UNPARSABLE ? UNKNOWN : `j${canonicalJson(parsed)}`;
      },
      stored: (value) => {
        const parsed = parsedJson(value);
        return parsed === UNPARSABLE ? NEVER : `j${storedJson(parsed)}`;
      }
    };
  }
  return { computed: () => UNKNOWN, stored: () => NEVER };
}

function columnCanonicalsFor(column: ColumnMetadata): ColumnCanonicals {
  const typed = typedCanonicals(String(column.type).toLowerCase());
  // Written as DEFAULT: known only for a nullable column without one.
  const undefinedIsNull = column.isNullable && column.default === undefined;
  return {
    computed: (value) => {
      if (value === undefined) return undefinedIsNull ? NULL : UNKNOWN;
      return value === null ? NULL : typed.computed(value);
    },
    stored: (value) => {
      if (value === null) return NULL;
      return value === undefined ? NEVER : typed.stored(value);
    }
  };
}

type EntityValue = (row: ObjectLiteral) => unknown;

/** A plain property read where the column is not embedded (much faster). */
function entityValueFor(column: ColumnMetadata): EntityValue {
  if (column.embeddedMetadata) return (row) => column.getEntityValue(row);
  const property = column.propertyName;
  return (row) => row[property];
}

/** How to read, key and compare one table's rows, built once per table. */
type TablePlan = {
  readonly columns: ColumnMetadata[];
  readonly canonicals: ColumnCanonicals[];
  readonly entityValues: EntityValue[];
  readonly databaseNames: string[];
  /** Indexes into `columns` of the primary columns, in their key order. */
  readonly primary: number[];
  /** The primary columns' property names, in the same order. */
  readonly primaryNames: string[];
};

const plans = new WeakMap<EntityMetadata, TablePlan>();

function planFor(metadata: EntityMetadata): TablePlan {
  let plan = plans.get(metadata);
  if (!plan) {
    const columns = metadata.columns;
    plan = {
      columns,
      canonicals: columns.map(columnCanonicalsFor),
      entityValues: columns.map(entityValueFor),
      databaseNames: columns.map((column) => column.databaseName),
      primary: metadata.primaryColumns.map((column) => columns.indexOf(column)),
      primaryNames: metadata.primaryColumns.map((column) => column.propertyName)
    };
    plans.set(metadata, plan);
  }
  return plan;
}

const oneShotHash = (
  crypto as unknown as {
    hash?: (algorithm: string, data: string, encoding: 'base64') => string;
  }
).hash;

const SEPARATOR = '\u0000';

/** SHA-256, as base64. */
function digest(text: string): string {
  return oneShotHash
    ? oneShotHash('sha256', text, 'base64')
    : crypto.createHash('sha256').update(text).digest('base64');
}

/**
 * A row's key: a digest of its primary key values, lowercased (MySQL
 * compares these keys case-insensitively, with ci collations).
 */
function rowKey(plan: TablePlan, valueAt: (i: number) => unknown) {
  let key = '';
  for (const i of plan.primary) {
    key += String(valueAt(i)).toLowerCase() + SEPARATOR;
  }
  return digest(key);
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

/** A row's key column values, by property name. */
export type KeyValues = (property: string) => unknown;

/** One table of a partial write. */
export type PartialTableWrite = {
  readonly columns?: RowDiffColumns;
  /**
   * Whether a row is in the write's scope (its affected wallets or replaced
   * consolidation keys), from its key columns: the full-row path deleted
   * these rows before writing.
   */
  readonly inScope: (key: KeyValues) => boolean;
};

/** The columns digested together, and the refreshed one, of one table. */
type Comparison = {
  readonly compared: number[];
  readonly refreshedAt: number;
  /** Identifies the columns, so stored and computed digests match. */
  readonly signature: string;
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

function comparisonFor(
  plan: TablePlan,
  metadata: EntityMetadata,
  { recomputed = [], refreshed }: RowDiffColumns = {}
): Comparison {
  const skipped = new Set(
    recomputed.map((name) => columnIndex(plan, metadata, name))
  );
  const refreshedAt =
    refreshed === undefined ? -1 : columnIndex(plan, metadata, refreshed);
  return {
    compared: plan.columns
      .map((_, i) => i)
      .filter((i) => !skipped.has(i) && i !== refreshedAt),
    refreshedAt,
    signature: JSON.stringify([
      metadata.tableName,
      Array.from(skipped).sort((x, y) => x - y),
      refreshedAt
    ])
  };
}

/** The digest of a row's compared columns, from their canonical texts. */
function rowDigest(
  comparison: Comparison,
  canonicalAt: (i: number) => string
): string {
  let text = '';
  for (const i of comparison.compared) {
    const canonical = canonicalAt(i);
    text += `${canonical.length}:${canonical}`;
  }
  return digest(text);
}

/** A table's stored rows, as digests: what a partial write compares with. */
export type StoredRows = {
  readonly signature: string;
  /** Each stored row's digest, by key. */
  readonly digests: Map<string, string>;
  /** Each stored row's refreshed column, as canonical text, by key. */
  readonly refreshed: Map<string, string>;
  /** The key column values of the stored rows a write may delete, by key. */
  readonly keys: Map<string, unknown[]>;
};

/**
 * `stored` (a snapshot, which keeps every row's key values) with its rows in
 * the write's scope replaced by `scope`, read since: so the scope is compared
 * with, and deletes, what is stored at the write.
 */
export function withScopeRows(
  stored: StoredRows,
  scope: StoredRows,
  metadata: EntityMetadata,
  write: PartialTableWrite
): StoredRows {
  if (stored.signature !== scope.signature) {
    throw new Error(`${metadata.tableName}: scope rows read for other columns`);
  }
  const plan = planFor(metadata);
  stored.keys.forEach((values, key) => {
    if (write.inScope(keyValuesOf(plan, values))) {
      stored.digests.delete(key);
      stored.refreshed.delete(key);
      stored.keys.delete(key);
    }
  });
  scope.digests.forEach((digest, key) => stored.digests.set(key, digest));
  scope.refreshed.forEach((text, key) => stored.refreshed.set(key, text));
  scope.keys.forEach((values, key) => stored.keys.set(key, values));
  return stored;
}

/** Frees a table's stored rows once compared. */
export function releaseStoredRows(stored: StoredRows): void {
  stored.digests.clear();
  stored.refreshed.clear();
  stored.keys.clear();
}

function keyValuesOf(plan: TablePlan, values: readonly unknown[]): KeyValues {
  return (property) => {
    const i = plan.primaryNames.indexOf(property);
    if (i < 0) throw new Error(`${property} is not a key column`);
    return values[i];
  };
}

/** Collects stored rows, each given by a column value reader. */
function storedRowsCollector(
  plan: TablePlan,
  comparison: Comparison,
  keepKey?: (key: KeyValues) => boolean
) {
  const stored: StoredRows = {
    signature: comparison.signature,
    digests: new Map(),
    refreshed: new Map(),
    keys: new Map()
  };
  const add = (valueAt: (i: number) => unknown) => {
    const key = rowKey(plan, valueAt);
    stored.digests.set(
      key,
      rowDigest(comparison, (i) => plan.canonicals[i].stored(valueAt(i)))
    );
    if (comparison.refreshedAt >= 0) {
      const i = comparison.refreshedAt;
      stored.refreshed.set(key, plan.canonicals[i].stored(valueAt(i)));
    }
    const keyValues = plan.primary.map((i) => valueAt(i));
    if (!keepKey || keepKey(keyValuesOf(plan, keyValues))) {
      stored.keys.set(key, keyValues);
    }
  };
  return { stored, add };
}

/**
 * Entity-shaped rows as stored now (as read, JSON parsed), reduced to
 * digests at once, so a later in-place change to the same objects (ranking
 * does that) does not affect them. Every row's key values are kept.
 */
export function snapshotRows(
  metadata: EntityMetadata,
  rows: readonly ObjectLiteral[],
  columns?: RowDiffColumns
): StoredRows {
  const plan = planFor(metadata);
  const { stored, add } = storedRowsCollector(
    plan,
    comparisonFor(plan, metadata, columns)
  );
  for (const row of rows) add((i) => plan.entityValues[i](row));
  return stored;
}

/**
 * The stored rows of `metadata`'s table (optionally only those whose
 * `filter.column` equals `filter.value`), read on the caller's transaction
 * so they match what it writes against: a locking read (`for share`), which
 * sees the latest committed rows and keeps them locked until the caller
 * commits, as overwriting every row did. A concurrent writer (a full
 * rewrite, a rerun) waits for the partial write. The rows are streamed and
 * each is reduced to a digest as it arrives; key values are kept only for
 * the rows in the write's scope.
 */
export async function readStoredRows(
  manager: EntityManager,
  metadata: EntityMetadata,
  {
    filter,
    write
  }: {
    /** Only the rows whose columns have one of the given values. */
    readonly filter?: readonly {
      readonly column: string;
      readonly values: readonly unknown[];
    }[];
    readonly write: PartialTableWrite;
  }
): Promise<StoredRows> {
  const plan = planFor(metadata);
  const { stored, add } = storedRowsCollector(
    plan,
    comparisonFor(plan, metadata, write.columns),
    write.inScope
  );
  const keep = (row: ObjectLiteral) => add((i) => row[plan.databaseNames[i]]);
  if (filter?.some(({ values }) => values.length === 0)) return stored;

  const name = (identifier: string) => `\`${identifier.replace(/`/g, '``')}\``;
  const where = (filter ?? [])
    .map(
      ({ column, values }) =>
        `${name(column)} in (${values.map(() => '?').join(', ')})`
    )
    .join(' and ');
  const sql = `select * from ${name(metadata.tableName)}${where ? ` where ${where}` : ''}`;
  const params = (filter ?? []).flatMap(({ values }) => [...values]);
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

export type RowWrites<Entity> = {
  /** Rows to upsert in full: new, or different from the stored row. */
  readonly upserts: Entity[];
  /** Rows that differ from the stored row only in the refreshed column. */
  readonly refreshes: Entity[];
  /**
   * Key values of stored rows in scope to delete first: those whose computed
   * row differs (it is then inserted again) or is gone.
   */
  readonly deletes: unknown[][];
};

/**
 * What a partial write must send for one table so it ends as deleting its
 * scope and writing every computed row would leave it: new and changed rows,
 * date-only refreshes, and deletes of stored scope rows that changed or are
 * gone. Everything else is already stored as it is.
 */
export function rowsToWrite<Entity extends ObjectLiteral>(
  metadata: EntityMetadata,
  rows: readonly Entity[],
  stored: StoredRows,
  write: PartialTableWrite
): RowWrites<Entity> {
  const plan = planFor(metadata);
  const comparison = comparisonFor(plan, metadata, write.columns);
  if (comparison.signature !== stored.signature) {
    throw new Error(
      `${metadata.tableName}: stored rows were read for other columns`
    );
  }
  const upserts: Entity[] = [];
  const refreshes: Entity[] = [];
  /** Stored keys whose row is kept (unchanged, or only refreshed). */
  const kept = new Set<string>();
  for (const row of rows) {
    const valueAt = (i: number) => plan.entityValues[i](row);
    const key = rowKey(plan, valueAt);
    const storedDigest = stored.digests.get(key);
    if (
      storedDigest === undefined ||
      storedDigest !==
        rowDigest(comparison, (i) => plan.canonicals[i].computed(valueAt(i)))
    ) {
      upserts.push(row);
      continue;
    }
    const i = comparison.refreshedAt;
    if (
      i >= 0 &&
      plan.canonicals[i].computed(valueAt(i)) !== stored.refreshed.get(key)
    ) {
      refreshes.push(row);
    }
    if (stored.keys.has(key)) kept.add(key);
  }
  const deletes: unknown[][] = [];
  stored.keys.forEach((values, key) => {
    if (!kept.has(key) && write.inScope(keyValuesOf(plan, values))) {
      deletes.push(values);
    }
  });
  return { upserts, refreshes, deletes };
}
