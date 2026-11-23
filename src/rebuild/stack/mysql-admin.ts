import * as mysql from 'mysql';
import { DB_TEXT_COLLATION } from '@/db/db-collation';

export interface AdminTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

export type Row = Record<string, unknown>;

/** A root connection to the run's private server. Values come back as strings. */
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

  /** Streams a table's rows in a stable order. */
  async orderedRows(
    database: string,
    table: string,
    orderBy: readonly string[]
  ): Promise<Row[]> {
    const order = orderBy.length
      ? ` ORDER BY ${orderBy.map((column) => mysql.escapeId(column)).join(', ')}`
      : '';
    return this.query(
      `SELECT * FROM ${mysql.escapeId(database)}.${mysql.escapeId(table)}${order}`
    );
  }
}
