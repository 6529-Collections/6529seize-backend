import * as mysql from 'mysql';
import { DB_TEXT_COLLATION } from '@/db/db-collation';

export interface AdminTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

export type Row = Record<string, unknown>;

/** A column as information_schema describes it. */
export interface ColumnInfo {
  readonly name: string;
  /** DATA_TYPE, lower case: int, varchar, datetime, ... */
  readonly dataType: string;
  readonly nullable: boolean;
  /** Whether it has a default, a literal or an expression. */
  readonly hasDefault: boolean;
  /** EXTRA: auto_increment, DEFAULT_GENERATED, on update ..., ... GENERATED. */
  readonly extra: string;
}

const NUMERIC = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
  'bit'
]);
const TEXTUAL = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob'
]);

/**
 * The SQL a column is reset to for its owner to fill again: its default,
 * NULL for a nullable column without one, and for a NOT NULL column
 * without one its type's zero (0, or an empty string). A NOT NULL column
 * of another type without a default has none: null.
 */
export function resetValue(column: ColumnInfo): string | null {
  if (column.hasDefault) return 'DEFAULT';
  if (column.nullable) return 'NULL';
  if (NUMERIC.has(column.dataType)) return '0';
  if (TEXTUAL.has(column.dataType)) return "''";
  return null;
}

/** Whether MySQL writes a column itself: on update, or generated. */
export function writtenByMysql(column: ColumnInfo): boolean {
  return /on update|generated/i.test(
    column.extra.replace(/DEFAULT_GENERATED/i, '')
  );
}

/** A root connection to the run's private server. Values come back as strings. */
/**
 * Rows whose `columns` hold one of the tuples bound to its `?`
 * (`inside`), or none of them: a NULL in any column is none.
 */
function partitionWhere(columns: readonly string[], inside: boolean): string {
  const ids = columns.map((column) => mysql.escapeId(column));
  const tuple = `(${ids.join(', ')}) IN (?)`;
  return inside
    ? tuple
    : [...ids.map((id) => `${id} IS NULL`), `NOT (${tuple})`].join(' OR ');
}

export class MysqlAdmin {
  private constructor(private readonly connection: mysql.Connection) {}

  static async connect(target: AdminTarget): Promise<MysqlAdmin> {
    const connection = mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      connectTimeout: 5000
    });
    await new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve()))
    );
    return new MysqlAdmin(connection);
  }

  query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) =>
      this.connection.query(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows as T[])
      )
    );
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.connection.end(() => resolve()));
  }

  /** Ends the connection without waiting, after SHUTDOWN for example. */
  destroy(): void {
    this.connection.destroy();
  }

  async recreateDatabase(database: string): Promise<void> {
    const name = mysql.escapeId(database);
    await this.query(`DROP DATABASE IF EXISTS ${name}`);
    await this.query(
      `CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE ${DB_TEXT_COLLATION}`
    );
  }

  /** The run's application account: everything on one database. */
  async createAppUser(
    user: string,
    password: string,
    database: string
  ): Promise<void> {
    const who = `${mysql.escape(user)}@'%'`;
    await this.query(`DROP USER IF EXISTS ${who}`);
    await this.query(
      `CREATE USER ${who} IDENTIFIED WITH mysql_native_password BY ${mysql.escape(password)}`
    );
    await this.query(
      `GRANT ALL PRIVILEGES ON ${mysql.escapeId(database)}.* TO ${who}`
    );
    // Concurrency code reads information_schema.innodb_trx.
    await this.query(`GRANT PROCESS ON *.* TO ${who}`);
  }

  async run(statements: readonly string[]): Promise<void> {
    for (const statement of statements) await this.query(statement);
  }

  async baseTables(database: string): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
      [database]
    );
    return rows.map((row) => row.name);
  }

  async rowCount(database: string, table: string): Promise<number> {
    const [row] = await this.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)}`
    );
    return Number(row.n);
  }

  /**
   * The rows whose `columns` hold one of the tuples in `values`
   * (`inside`), or none of them (a NULL in any column is none).
   */
  async partitionRowCount(
    database: string,
    table: string,
    columns: readonly string[],
    values: readonly (readonly string[])[],
    inside: boolean
  ): Promise<number> {
    const [row] = await this.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)} WHERE ${partitionWhere(columns, inside)}`,
      [values.map((v) => [...v])]
    );
    return Number(row.n);
  }

  /** The rows of a partition (`inside`), or of everything outside it. */
  async partitionRows(
    database: string,
    table: string,
    columns: readonly string[],
    values: readonly (readonly string[])[],
    inside: boolean
  ): Promise<Row[]> {
    return this.query(
      `SELECT * FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)} WHERE ${partitionWhere(columns, inside)}`,
      [values.map((v) => [...v])]
    );
  }

  /** Deletes the rows whose `columns` hold one of the tuples in `values`. */
  async deletePartition(
    database: string,
    table: string,
    columns: readonly string[],
    values: readonly (readonly string[])[]
  ): Promise<void> {
    const ids = columns.map((column) => mysql.escapeId(column));
    await this.query(
      `DELETE FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)} WHERE (${ids.join(', ')}) IN (?)`,
      [values.map((v) => [...v])]
    );
  }

  /**
   * Columns a plain INSERT can fill: virtual and stored generated columns
   * left out. A column with a default expression (`DEFAULT CURRENT_TIMESTAMP`
   * shows as `DEFAULT_GENERATED` in EXTRA) stays, so a copy keeps its values.
   */
  async insertableColumns(database: string, table: string): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          AND EXTRA NOT REGEXP 'VIRTUAL GENERATED|STORED GENERATED'
        ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row) => row.name);
  }

  async primaryKey(database: string, table: string): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      `SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [database, table]
    );
    return rows.map((row) => row.name);
  }

  /** Copies tables, rows included, from one database to another. */
  async copyTables(
    from: string,
    to: string,
    tables: readonly string[]
  ): Promise<void> {
    for (const table of tables) {
      const source = `${mysql.escapeId(from)}.${mysql.escapeId(table)}`;
      const target = `${mysql.escapeId(to)}.${mysql.escapeId(table)}`;
      await this.query(`DROP TABLE IF EXISTS ${target}`);
      await this.query(`CREATE TABLE ${target} LIKE ${source}`);
      await this.copyRows(from, to, table);
    }
  }

  /** Inserts every row of `from.table` into the existing `to.table`. */
  async copyRows(from: string, to: string, table: string): Promise<void> {
    const columns = (await this.insertableColumns(to, table))
      .map((column) => mysql.escapeId(column))
      .join(', ');
    if (!columns) return;
    await this.query(
      `INSERT INTO ${mysql.escapeId(to)}.${mysql.escapeId(table)} (${columns})
       SELECT ${columns} FROM ${mysql.escapeId(from)}.${mysql.escapeId(table)}`
    );
  }

  async truncate(database: string, tables: readonly string[]): Promise<void> {
    for (const table of tables) {
      await this.query(
        `TRUNCATE TABLE ${mysql.escapeId(database)}.${mysql.escapeId(table)}`
      );
    }
  }

  /** Starts per-table I/O counting from zero. */
  async resetTableIo(): Promise<void> {
    await this.query(
      'TRUNCATE TABLE performance_schema.table_io_waits_summary_by_table'
    );
  }

  /** Reads and writes per table since the last reset. */
  async tableIo(
    database: string
  ): Promise<Record<string, { reads: number; writes: number }>> {
    const rows = await this.query<{ name: string; r: string; w: string }>(
      `SELECT OBJECT_NAME AS name, COUNT_READ AS r, COUNT_WRITE AS w
         FROM performance_schema.table_io_waits_summary_by_table
        WHERE OBJECT_SCHEMA = ?`,
      [database]
    );
    const io: Record<string, { reads: number; writes: number }> = {};
    for (const row of rows) {
      io[row.name] = { reads: Number(row.r), writes: Number(row.w) };
    }
    return io;
  }

  /** A table's rows matching an SQL condition on its columns. */
  async rowsWhere(
    database: string,
    table: string,
    where: string
  ): Promise<Row[]> {
    return this.query(
      `SELECT * FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)} WHERE (${where})`
    );
  }

  /**
   * A table's rows in `orderBy` order. With `newestBy`, only the rows
   * whose column holds its largest value, as MySQL compares it (MAX).
   */
  async orderedRows(
    database: string,
    table: string,
    orderBy: readonly string[],
    newestBy?: string
  ): Promise<Row[]> {
    const from = `${mysql.escapeId(database)}.${mysql.escapeId(table)}`;
    const where = newestBy
      ? ` WHERE ${mysql.escapeId(newestBy)} = (SELECT MAX(${mysql.escapeId(newestBy)}) FROM ${from})`
      : '';
    const order = orderBy.length
      ? ` ORDER BY ${orderBy.map((column) => mysql.escapeId(column)).join(', ')}`
      : '';
    return this.query(`SELECT * FROM ${from}${where}${order}`);
  }

  /**
   * The pairs of tuples (index in `a`, index in `b`) that MySQL takes as
   * one value in `columns` of `table`: both sides are written into
   * temporary copies of those columns, with their types and collations,
   * and joined on them.
   */
  async overlappingTuples(
    database: string,
    table: string,
    columns: readonly string[],
    a: readonly (readonly string[])[],
    b: readonly (readonly string[])[]
  ): Promise<[number, number][]> {
    const ids = columns.map((column) => mysql.escapeId(column));
    const db = mysql.escapeId(database);
    const from = `${db}.${mysql.escapeId(table)}`;
    // Temporary tables belong to the connection; the database names them.
    const left = `${db}.rebuild_partition_a`;
    const right = `${db}.rebuild_partition_b`;
    const copy = async (
      name: string,
      tuples: readonly (readonly string[])[]
    ) => {
      await this.query(`DROP TEMPORARY TABLE IF EXISTS ${name}`);
      await this.query(
        `CREATE TEMPORARY TABLE ${name} SELECT 0 AS rebuild_index, ${ids.join(', ')} FROM ${from} LIMIT 0`
      );
      if (tuples.length) {
        await this.query(
          `INSERT INTO ${name} (rebuild_index, ${ids.join(', ')}) VALUES ?`,
          [tuples.map((tuple, i) => [i, ...tuple])]
        );
      }
    };
    try {
      await copy(left, a);
      await copy(right, b);
      const rows = await this.query<{ ai: number; bi: number }>(
        `SELECT x.rebuild_index AS ai, y.rebuild_index AS bi
           FROM ${left} x JOIN ${right} y
             ON ${ids.map((id) => `x.${id} = y.${id}`).join(' AND ')}
          ORDER BY ai, bi`
      );
      return rows.map((row) => [Number(row.ai), Number(row.bi)]);
    } finally {
      await this.query(`DROP TEMPORARY TABLE IF EXISTS ${left}`);
      await this.query(`DROP TEMPORARY TABLE IF EXISTS ${right}`);
    }
  }

  /** A table's columns, in order; empty when there is no such table. */
  async columnNames(database: string, table: string): Promise<string[]> {
    const rows = await this.query<{ name: string }>(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row) => row.name);
  }

  /** What a table's columns are: type, NULL, default, and EXTRA. */
  async columnInfo(database: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.query<{
      name: string;
      dataType: string;
      nullable: string;
      columnDefault: string | null;
      extra: string;
    }>(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS columnDefault,
              EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    return rows.map((row) => ({
      name: row.name,
      dataType: row.dataType.toLowerCase(),
      nullable: row.nullable === 'YES',
      hasDefault: row.columnDefault !== null,
      extra: row.extra ?? ''
    }));
  }

  /** Sets `columns` of every row of a table to what `resetValue` gives. */
  async resetColumns(
    database: string,
    table: string,
    columns: readonly ColumnInfo[]
  ): Promise<void> {
    await this.query(
      `UPDATE ${mysql.escapeId(database)}.${mysql.escapeId(table)} SET ${columns
        .map(
          (column) => `${mysql.escapeId(column.name)} = ${resetValue(column)}`
        )
        .join(', ')}`
    );
  }

  /**
   * Copies a table's key and `columns` into `into` (in `toDb`), to put
   * them back later with `restoreColumns`.
   */
  async saveColumns(
    database: string,
    table: string,
    key: readonly string[],
    columns: readonly string[],
    toDb: string,
    into: string
  ): Promise<void> {
    const target = `${mysql.escapeId(toDb)}.${mysql.escapeId(into)}`;
    await this.query(`DROP TABLE IF EXISTS ${target}`);
    await this.query(
      `CREATE TABLE ${target} AS SELECT ${[...key, ...columns]
        .map((column) => mysql.escapeId(column))
        .join(', ')} FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)}`
    );
  }

  /**
   * Puts saved `columns` back on the rows whose key the copy holds; rows
   * it doesn't hold keep theirs.
   */
  async restoreColumns(
    database: string,
    table: string,
    key: readonly string[],
    columns: readonly string[],
    fromDb: string,
    from: string
  ): Promise<void> {
    const t = mysql.escapeId('t');
    const s = mysql.escapeId('s');
    await this.query(
      `UPDATE ${mysql.escapeId(database)}.${mysql.escapeId(table)} ${t}
         JOIN ${mysql.escapeId(fromDb)}.${mysql.escapeId(from)} ${s}
           ON ${key.map((c) => `${t}.${mysql.escapeId(c)} = ${s}.${mysql.escapeId(c)}`).join(' AND ')}
          SET ${columns.map((c) => `${t}.${mysql.escapeId(c)} = ${s}.${mysql.escapeId(c)}`).join(', ')}`
    );
  }

  /** Whether a column may hold NULL; null when the table has no such column. */
  async columnNullable(
    database: string,
    table: string,
    column: string
  ): Promise<boolean | null> {
    const rows = await this.query<{ nullable: string }>(
      `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [database, table, column]
    );
    return rows.length ? rows[0].nullable === 'YES' : null;
  }
}
