import { createHash } from 'node:crypto';
import * as mysql from 'mysql';

/** MySQL user names are at most 32 characters. */
export function stepUserName(stepId: string): string {
  return `rb_${createHash('sha256').update(stepId).digest('hex').slice(0, 16)}`;
}

export interface StepGrants {
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** Tables the step may read and change. */
  readonly writes: readonly string[];
  /** Tables the step may only read. */
  readonly reads: readonly string[];
  /**
   * Tables the step may change only in some columns (a table with column
   * owners): read the whole table, insert and update only `insert` and
   * `update`, and delete rows only with `delete`. Each replaces any
   * grant `writes` would give the table.
   */
  readonly columns?: readonly ColumnGrant[];
}

export interface ColumnGrant {
  readonly table: string;
  readonly insert: readonly string[];
  readonly update: readonly string[];
  readonly delete: boolean;
}

const WRITE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

function account(user: string): string {
  return `${mysql.escape(user)}@'%'`;
}

/**
 * Statements that create a user who can change exactly `writes` and read
 * exactly `writes` and `reads` in one database, plus its own temporary
 * tables. Anything else the step touches is refused by MySQL.
 *
 * Production writers lock rows they only read (SELECT ... FOR UPDATE),
 * which MySQL allows only with a write privilege or LOCK TABLES. LOCK TABLES
 * lets a step lock the tables it may read; it never lets it change them.
 */
export function stepGrantStatements(grants: StepGrants): string[] {
  const who = account(grants.user);
  const database = mysql.escapeId(grants.database);
  const table = (name: string) => `${database}.${mysql.escapeId(name)}`;
  const columnGrants = grants.columns ?? [];
  const limited = new Set(columnGrants.map((grant) => grant.table));
  const writes = Array.from(new Set(grants.writes)).filter(
    (name) => !limited.has(name)
  );
  const reads = Array.from(new Set(grants.reads)).filter(
    (name) => !writes.includes(name) && !limited.has(name)
  );
  const columnList = (columns: readonly string[]) =>
    columns.map((column) => mysql.escapeId(column)).join(', ');
  return [
    `DROP USER IF EXISTS ${who}`,
    `CREATE USER ${who} IDENTIFIED WITH mysql_native_password BY ${mysql.escape(grants.password)}`,
    `GRANT CREATE TEMPORARY TABLES ON ${database}.* TO ${who}`,
    `GRANT LOCK TABLES ON ${database}.* TO ${who}`,
    ...writes.map(
      (name) => `GRANT ${WRITE_PRIVILEGES} ON ${table(name)} TO ${who}`
    ),
    ...reads.map((name) => `GRANT SELECT ON ${table(name)} TO ${who}`),
    ...columnGrants.flatMap((grant) => [
      `GRANT SELECT${grant.delete ? ', DELETE' : ''} ON ${table(grant.table)} TO ${who}`,
      ...(grant.insert.length
        ? [
            `GRANT INSERT (${columnList(grant.insert)}) ON ${table(grant.table)} TO ${who}`
          ]
        : []),
      ...(grant.update.length
        ? [
            `GRANT UPDATE (${columnList(grant.update)}) ON ${table(grant.table)} TO ${who}`
          ]
        : [])
    ])
  ];
}

export function dropUserStatement(user: string): string {
  return `DROP USER IF EXISTS ${account(user)}`;
}
