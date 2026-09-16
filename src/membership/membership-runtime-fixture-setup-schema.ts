import { DataSource, QueryRunner } from 'typeorm';
import { USER_GROUPS_TABLE } from '@/constants';
import {
  assertFixtureGeneratedExpression,
  FIXTURE_METADATA_DDL,
  FIXTURE_METADATA_TABLE,
  fixtureMetadataInsert,
  fixtureMetadataRecoveryInsert,
  inspectFixtureMetadata
} from './membership-runtime-fixture-setup-metadata';
import {
  MembershipSchemaReader,
  executeMembershipOnlineIndex,
  withMembershipSchemaInspection
} from '@/dbMigrationsLoop/membership-additive-schema';
import {
  membershipFixtureEntities,
  MEMBERSHIP_FIXTURE_MANIFEST_HASH
} from './membership-runtime-fixture-manifest';
import {
  MEMBERSHIP_FIXTURE_CONTROL_TABLE,
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_OWNER
} from './membership-runtime-policy';

export interface MembershipFixtureEnvironment {
  readonly stage: string;
  readonly region: string;
}
export function assertMembershipFixtureEnvironment(
  environment: MembershipFixtureEnvironment
): void {
  if (environment.stage !== 'staging' || environment.region !== 'eu-west-1')
    throw new Error('Membership fixture requires staging eu-west-1');
}
/** Server-only connection; never replaces the application's immutable DB selection. */
export async function createMembershipFixtureDatabase(
  source: DataSource,
  environment: MembershipFixtureEnvironment,
  applicationDatabase: string
): Promise<void> {
  assertMembershipFixtureEnvironment(environment);
  if (
    !source.isInitialized ||
    !applicationDatabase ||
    applicationDatabase === MEMBERSHIP_FIXTURE_DATABASE ||
    source.entityMetadatas.length ||
    (source.options.database !== undefined &&
      source.options.database !== applicationDatabase)
  )
    throw new Error(
      'Fixture database creation requires an isolated server connection'
    );
  const runner = source.createQueryRunner('master');
  try {
    await withMembershipSchemaInspection(source, async ({ runner: reader }) => {
      const rows: { selected: string | null }[] = await reader.query(
        'SELECT DATABASE() selected'
      );
      if (
        rows.length !== 1 ||
        (rows[0].selected !== null && rows[0].selected !== applicationDatabase)
      )
        throw new Error('Unexpected server database selection');
    });
    await executeMembershipOnlineIndex(
      runner,
      `CREATE DATABASE IF NOT EXISTS \`${MEMBERSHIP_FIXTURE_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      5000
    );
  } finally {
    await runner.release();
  }
}
function assertScope(
  source: DataSource,
  environment: MembershipFixtureEnvironment
): void {
  assertMembershipFixtureEnvironment(environment);
  if (
    !source.isInitialized ||
    source.options.database !== MEMBERSHIP_FIXTURE_DATABASE ||
    source.entityMetadatas.length !== membershipFixtureEntities.length ||
    source.entityMetadatas.some(
      (metadata) =>
        !membershipFixtureEntities.some((entity) => metadata.target === entity)
    )
  )
    throw new Error('Fixture schema requires the exact isolated entity scope');
}
type FixtureObject = { name: string; kind: string };
async function inspectObjects(
  runner: QueryRunner,
  expected: readonly string[]
): Promise<FixtureObject[]> {
  const selected: { selected: string }[] = await runner.query(
    'SELECT DATABASE() selected'
  );
  if (
    selected.length !== 1 ||
    selected[0].selected !== MEMBERSHIP_FIXTURE_DATABASE
  )
    throw new Error('Fixture schema database selection mismatch');
  const objects: FixtureObject[] = await runner.query(
    'SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() LIMIT 22'
  );
  if (
    objects.some(
      (object) =>
        object.kind !== 'BASE TABLE' ||
        (!expected.includes(object.name) &&
          object.name !== FIXTURE_METADATA_TABLE)
    ) ||
    objects.length > expected.length + 1
  )
    throw new Error('Fixture database contains unknown objects');
  for (const [table, column] of [
    ['triggers', 'TRIGGER_SCHEMA'],
    ['routines', 'ROUTINE_SCHEMA'],
    ['events', 'EVENT_SCHEMA']
  ] as const) {
    if (
      (
        await runner.query(
          `SELECT 1 FROM information_schema.${table} WHERE ${column}=DATABASE() LIMIT 1`
        )
      ).length
    )
      throw new Error('Fixture database contains unknown executable objects');
  }
  return objects;
}
async function compatibleOwner(
  runner: QueryRunner,
  objects: readonly FixtureObject[]
): Promise<boolean> {
  if (
    !objects.some((object) => object.name === MEMBERSHIP_FIXTURE_CONTROL_TABLE)
  )
    return false;
  const rows: {
    id: string;
    protocol_version: number | string;
    manifest_hash: string;
  }[] = await runner.query(
    `SELECT id,protocol_version,manifest_hash FROM ${MEMBERSHIP_FIXTURE_CONTROL_TABLE} LIMIT 2`
  );
  if (!rows.length) return false;
  if (
    rows.length !== 1 ||
    rows[0].id !== MEMBERSHIP_FIXTURE_OWNER ||
    String(rows[0].protocol_version) !== '1' ||
    rows[0].manifest_hash !== MEMBERSHIP_FIXTURE_MANIFEST_HASH
  )
    throw new Error('Fixture ownership mismatch');
  return true;
}
async function inspectAdoption(
  runner: QueryRunner,
  objects: readonly FixtureObject[],
  missing: readonly string[]
): Promise<void> {
  if (await compatibleOwner(runner, objects)) {
    if (missing.length)
      throw new Error('Owned fixture lost an application table');
    return;
  }
  for (const object of objects.filter(
    (item) => item.name !== FIXTURE_METADATA_TABLE
  )) {
    // Names were already matched against the closed entity allowlist.
    if ((await runner.query(`SELECT 1 FROM \`${object.name}\` LIMIT 1`)).length)
      throw new Error('Cannot adopt populated unowned fixture database');
  }
}
async function inspectedCreates(
  source: DataSource,
  reader: MembershipSchemaReader,
  objects: readonly FixtureObject[],
  expected: readonly string[]
) {
  const [metadataSql, metadataParams] = fixtureMetadataInsert(source);
  const plan = await reader.log();
  const approvedMetadata = plan.upQueries.filter(
    (query) =>
      query.query === metadataSql &&
      JSON.stringify(query.parameters) === JSON.stringify(metadataParams)
  );
  if (approvedMetadata.length > 1)
    throw new Error('Duplicate generated-column metadata plan');
  const missing = expected.filter(
    (table) => !objects.some((object) => object.name === table)
  );
  const creates = plan.upQueries
    .filter((query) => !approvedMetadata.includes(query))
    .map((query) => ({
      query,
      table: /^CREATE TABLE `([a-z_0-9]+)` /.exec(query.query)?.[1]
    }));
  if (
    creates.length !== missing.length ||
    creates.some(
      ({ query, table }) =>
        !table || !missing.includes(table) || query.parameters?.length
    ) ||
    new Set(creates.map(({ table }) => table)).size !== missing.length
  )
    throw new Error('Fixture schema contains unapproved changes');
  await inspectAdoption(reader.runner, objects, missing);
  return creates.map(({ query }) => query.query);
}
async function inspectMembershipFixtureSchema(
  source: DataSource,
  environment: MembershipFixtureEnvironment
) {
  assertScope(source, environment);
  const expected = membershipFixtureEntities.map(
    (entity) => source.getMetadata(entity).tableName
  );
  return withMembershipSchemaInspection(source, async (reader) => {
    const objects = await inspectObjects(reader.runner, expected);
    const metadataExists = objects.some(
      (object) => object.name === FIXTURE_METADATA_TABLE
    );
    const metadataReady = metadataExists
      ? await inspectFixtureMetadata(source, reader.runner)
      : false;
    const groupExists = objects.some(
      (object) => object.name === USER_GROUPS_TABLE
    );
    if (groupExists)
      await assertFixtureGeneratedExpression(source, reader.runner);
    if (groupExists && !metadataReady) {
      if (await compatibleOwner(reader.runner, objects))
        throw new Error('Owned fixture lost generated-column metadata');
      const missing = expected.filter(
        (table) => !objects.some((object) => object.name === table)
      );
      await inspectAdoption(reader.runner, objects, missing);
      return {
        statements: metadataExists ? [] : [FIXTURE_METADATA_DDL],
        metadataReady: false,
        metadataStatement: fixtureMetadataRecoveryInsert(source),
        expected_tables: expected.length + 1,
        repairOnly: true,
        missing_tables: missing.length
      };
    }
    const creates = await inspectedCreates(source, reader, objects, expected);
    return {
      statements: [
        ...(metadataExists ? [] : [FIXTURE_METADATA_DDL]),
        ...creates
      ],
      metadataReady,
      metadataStatement: fixtureMetadataRecoveryInsert(source),
      expected_tables: expected.length + 1,
      repairOnly: false,
      missing_tables: creates.length + (metadataExists ? 0 : 1)
    };
  });
}

export async function preflightMembershipFixtureSchema(
  source: DataSource,
  environment: MembershipFixtureEnvironment
) {
  const inspection = await inspectMembershipFixtureSchema(source, environment);
  return {
    ready:
      !inspection.repairOnly &&
      inspection.statements.length === 0 &&
      inspection.metadataReady,
    missing_tables: inspection.missing_tables,
    metadata_ready: inspection.metadataReady,
    verified_tables: inspection.expected_tables - inspection.missing_tables
  };
}

export async function prepareMembershipFixtureSchema(
  source: DataSource,
  environment: MembershipFixtureEnvironment
) {
  const inspection = await inspectMembershipFixtureSchema(source, environment);
  const runner = source.createQueryRunner('master');
  let created = 0;
  try {
    for (const statement of inspection.statements.slice(0, 4)) {
      await executeMembershipOnlineIndex(runner, statement, 5000);
      created++;
    }
  } finally {
    await runner.release();
  }
  const remaining = inspection.statements.length - created;
  if (!remaining && !inspection.metadataReady) {
    const metadataRunner = source.createQueryRunner('master');
    try {
      await executeMembershipOnlineIndex(
        metadataRunner,
        inspection.metadataStatement,
        3000
      );
    } finally {
      await metadataRunner.release();
    }
  }
  if (!remaining && !inspection.repairOnly)
    await withMembershipSchemaInspection(
      source,
      async ({ log, runner: reader }) => {
        await assertFixtureGeneratedExpression(source, reader);
        if (!(await inspectFixtureMetadata(source, reader)))
          throw new Error('Missing fixture generated-column metadata');
        if ((await log()).upQueries.length)
          throw new Error('Fixture schema verification failed');
      }
    );
  return {
    ready: remaining === 0 && !inspection.repairOnly,
    created_tables: created,
    remaining_tables: inspection.repairOnly
      ? inspection.missing_tables
      : remaining,
    verified_tables:
      remaining || inspection.repairOnly ? 0 : inspection.expected_tables
  };
}
