import { createHash } from 'node:crypto';
import { QueryRunner } from 'typeorm';

// An operator-only allowlist. This module is never imported by a Lambda handler.
export const RETIRED_MEMBERSHIP_TABLES = [
  'membership_generation_members',
  'membership_group_versions',
  // Superseded prototype tables, independently inventoried before retirement.
  'membership_materialization_states',
  'membership_publications',
  'membership_refresh_requests',
  'membership_refresh_runs',
  'membership_refresh_targets',
  'membership_runtime_checkpoints',
  'membership_source_jobs',
  'membership_source_states',
  'membership_watermarks',
  'user_group_members'
] as const;

export interface RetirementInventory {
  database: string;
  serverUuid: string;
  tables: {
    name: string;
    definitionSha256: string;
    rows: string;
    checksum: string;
  }[];
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value))
    throw new Error('Invalid database identifier');
  return `\`${value}\``;
}

async function rejectDependencies(runner: QueryRunner, database: string) {
  const placeholders = RETIRED_MEMBERSHIP_TABLES.map(() => '?').join(', ');
  const dependencies: { name: string }[] = await runner.query(
    `SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) AS name
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IN (${placeholders})
     UNION ALL
     SELECT CONCAT(VIEW_SCHEMA, '.', VIEW_NAME) AS name
       FROM information_schema.VIEW_TABLE_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    [
      database,
      ...RETIRED_MEMBERSHIP_TABLES,
      database,
      ...RETIRED_MEMBERSHIP_TABLES
    ]
  );
  const programs: { definition: string | null }[] = await runner.query(
    `SELECT ROUTINE_DEFINITION AS definition FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL SELECT EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
    [database, database, database]
  );
  if (
    dependencies.length ||
    programs.some(
      (row) =>
        row.definition === null ||
        /\b(?:membership_|user_group_members\b)/i.test(row.definition)
    )
  )
    throw new Error(
      'Retired schema has dependencies or unreadable stored programs'
    );
}

/** A read-only inventory, including frozen backlog rather than pretending it is empty. */
export async function inspectRetiredSchema(
  runner: QueryRunner
): Promise<RetirementInventory> {
  const [identity]: { database: string; serverUuid: string }[] =
    await runner.query(
      'SELECT DATABASE() AS `database`, @@server_uuid AS serverUuid'
    );
  identifier(identity.database);
  await rejectDependencies(runner, identity.database);
  const objects: { name: string; kind: string; engine: string | null }[] =
    await runner.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, ENGINE AS engine FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND (LEFT(TABLE_NAME, 11) = 'membership_' OR TABLE_NAME = 'user_group_members') ORDER BY TABLE_NAME`,
      [identity.database]
    );
  if (
    objects.some(
      (row) =>
        row.kind !== 'BASE TABLE' ||
        row.engine !== 'InnoDB' ||
        !RETIRED_MEMBERSHIP_TABLES.some((name) => name === row.name)
    )
  ) {
    throw new Error(
      'Unexpected membership schema objects; inventory them separately'
    );
  }
  const tables: RetirementInventory['tables'] = [];
  for (const { name } of objects) {
    const qualified = `${identifier(identity.database)}.${identifier(name)}`;
    const [definition]: { 'Create Table': string }[] = await runner.query(
      `SHOW CREATE TABLE ${qualified}`
    );
    const [count]: { rows: string }[] = await runner.query(
      `SELECT CAST(COUNT(*) AS CHAR) AS \`rows\` FROM ${qualified}`
    );
    const [checksum]: { Checksum: number | string | null }[] =
      await runner.query(`CHECKSUM TABLE ${qualified} EXTENDED`);
    if (checksum.Checksum === null)
      throw new Error('Table checksum is unavailable');
    tables.push({
      name,
      definitionSha256: sha256(definition['Create Table']),
      rows: count.rows,
      checksum: String(checksum.Checksum)
    });
  }
  return { ...identity, tables };
}

/** Called only by the explicit retirement CLI after backup and operational gates. */
export async function dropRetiredSchema(
  runner: QueryRunner,
  approved: RetirementInventory
): Promise<void> {
  const [previous]: { timeout: number | string }[] = await runner.query(
    'SELECT @@SESSION.lock_wait_timeout AS timeout'
  );
  const [lock]: { acquired: number | string }[] = await runner.query(
    "SELECT GET_LOCK('retire-membership-schema-v1', 0) AS acquired"
  );
  if (Number(lock.acquired) !== 1)
    throw new Error('Another retirement operation is running');
  try {
    await runner.query('SET SESSION lock_wait_timeout = 1');
    const actual = await inspectRetiredSchema(runner);
    if (JSON.stringify(actual) !== JSON.stringify(approved))
      throw new Error(
        'Database identity, schema or data changed after approved inventory'
      );
    if (!actual.tables.length) return;
    // MySQL 8 atomic DDL: the complete allowlisted set is dropped in one statement.
    await runner.query(
      `DROP TABLE ${actual.tables.map(({ name }) => `${identifier(actual.database)}.${identifier(name)}`).join(', ')}`
    );
    if ((await inspectRetiredSchema(runner)).tables.length)
      throw new Error('Retired table removal did not complete');
  } finally {
    try {
      await runner.query('SET SESSION lock_wait_timeout = ?', [
        Number(previous.timeout)
      ]);
    } finally {
      await runner.query("SELECT RELEASE_LOCK('retire-membership-schema-v1')");
    }
  }
}
