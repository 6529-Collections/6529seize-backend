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
}

const WRITE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

function account(user: string): string {
  return `${mysql.escape(user)}@'%'`;
}

/**
 * Statements that create a user who can change exactly `writes` and read
 * exactly `writes` and `reads` in one database, plus its own temporary
 * tables. Anything else the step touches is refused by MySQL.
 */
export function stepGrantStatements(grants: StepGrants): string[] {
  const who = account(grants.user);
  const database = mysql.escapeId(grants.database);
  const table = (name: string) => `${database}.${mysql.escapeId(name)}`;
  const writes = Array.from(new Set(grants.writes));
  const reads = Array.from(new Set(grants.reads)).filter(
    (name) => !writes.includes(name)
  );
  return [
    `DROP USER IF EXISTS ${who}`,
    `CREATE USER ${who} IDENTIFIED WITH mysql_native_password BY ${mysql.escape(grants.password)}`,
    `GRANT CREATE TEMPORARY TABLES ON ${database}.* TO ${who}`,
    ...writes.map(
      (name) => `GRANT ${WRITE_PRIVILEGES} ON ${table(name)} TO ${who}`
    ),
    ...reads.map((name) => `GRANT SELECT ON ${table(name)} TO ${who}`)
  ];
}

export function dropUserStatement(user: string): string {
  return `DROP USER IF EXISTS ${account(user)}`;
}
