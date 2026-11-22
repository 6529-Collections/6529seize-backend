import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';

/**
 * Columns are read from the live schema, so a column a migration adds is
 * captured without a code change. Each value is selected in a form that
 * survives JSON and writes back to the same stored value:
 * - datetime and date: formatted text, written back as text;
 * - timestamp: Unix seconds with fraction, written back through FROM_UNIXTIME,
 *   which does not depend on the session time zone;
 * - json, bigint, decimal: text;
 * - tinyint: a number (the driver would otherwise turn it into a boolean);
 * - other numbers and strings: as the driver returns them.
 * Generated columns are skipped: the database computes them.
 */

export type MintColumnKind =
  | 'datetime'
  | 'date'
  | 'timestamp'
  | 'json'
  | 'text-number'
  | 'tinyint'
  | 'plain';

export interface MintColumn {
  readonly name: string;
  readonly kind: MintColumnKind;
}

interface InformationSchemaColumn {
  readonly name: string;
  readonly data_type: string;
  readonly extra: string | null;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unexpected identifier ${name}`);
  }
  return `\`${name}\``;
}

export function columnKindOf(dataType: string): MintColumnKind {
  switch (dataType.toLowerCase()) {
    case 'datetime':
      return 'datetime';
    case 'date':
      return 'date';
    case 'timestamp':
      return 'timestamp';
    case 'json':
      return 'json';
    case 'bigint':
    case 'decimal':
      return 'text-number';
    case 'tinyint':
      return 'tinyint';
    default:
      return 'plain';
  }
}

export function selectExpression(column: MintColumn): string {
  const id = quoteIdentifier(column.name);
  switch (column.kind) {
    case 'datetime':
      return `DATE_FORMAT(${id}, '%Y-%m-%d %H:%i:%s.%f') AS ${id}`;
    case 'date':
      return `DATE_FORMAT(${id}, '%Y-%m-%d') AS ${id}`;
    case 'timestamp':
      return `CAST(UNIX_TIMESTAMP(${id}) AS CHAR) AS ${id}`;
    case 'json':
    case 'text-number':
      return `CAST(${id} AS CHAR) AS ${id}`;
    case 'tinyint':
      return `CAST(${id} AS SIGNED) AS ${id}`;
    case 'plain':
      return id;
  }
}

/** The value placeholder for a write of this column, with its parameter name. */
export function writeExpression(column: MintColumn, param: string): string {
  return column.kind === 'timestamp' ? `FROM_UNIXTIME(:${param})` : `:${param}`;
}

/**
 * VIRTUAL or STORED GENERATED columns are computed by the database. EXTRA also
 * says DEFAULT_GENERATED for a column whose default is an expression such as
 * CURRENT_TIMESTAMP; those columns hold data and are kept.
 */
export function isGeneratedColumn(extra: string | null): boolean {
  return /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra ?? '');
}

export class MintColumnCatalog {
  private readonly cache = new Map<string, Promise<MintColumn[]>>();

  constructor(private readonly db: () => SqlExecutor) {}

  /** The table's stored columns in schema order, minus `excluded`. */
  async columns(
    table: string,
    excluded: readonly string[],
    connection?: ConnectionWrapper<any>
  ): Promise<MintColumn[]> {
    let pending = this.cache.get(table);
    if (!pending) {
      pending = this.load(table, connection);
      this.cache.set(table, pending);
      pending.catch(() => this.cache.delete(table));
    }
    const all = await pending;
    return all.filter((column) => !excluded.includes(column.name));
  }

  private async load(
    table: string,
    connection?: ConnectionWrapper<any>
  ): Promise<MintColumn[]> {
    const rows = await this.db().execute<InformationSchemaColumn>(
      `select COLUMN_NAME as name, DATA_TYPE as data_type, EXTRA as extra
       from information_schema.COLUMNS
       where TABLE_SCHEMA = database() and TABLE_NAME = :table
       order by ORDINAL_POSITION`,
      { table },
      connection ? { wrappedConnection: connection } : undefined
    );
    if (!rows.length) {
      throw new Error(`Table ${table} has no columns in this schema`);
    }
    return rows
      .filter((row) => !isGeneratedColumn(row.extra))
      .map((row) => ({
        name: row.name,
        kind: columnKindOf(row.data_type)
      }));
  }
}
