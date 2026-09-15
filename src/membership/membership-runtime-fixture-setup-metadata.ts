import { DataSource, QueryRunner } from 'typeorm';
import { format } from 'mysql';
import { USER_GROUPS_TABLE } from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { MEMBERSHIP_FIXTURE_DATABASE } from './membership-runtime-policy';

/** Installed TypeORM's infrastructure schema; deliberately has no application entity/PK. */
export const FIXTURE_METADATA_TABLE = 'typeorm_metadata';
export const FIXTURE_METADATA_DDL =
  'CREATE TABLE `typeorm_metadata` (`type` varchar(255) NOT NULL, `database` varchar(255) NULL, `schema` varchar(255) NULL, `table` varchar(255) NULL, `name` varchar(255) NULL, `value` text NULL) ENGINE=InnoDB';
export function fixtureMetadataInsert(source: DataSource): [string, unknown[]] {
  return source
    .createQueryBuilder()
    .insert()
    .into(`${MEMBERSHIP_FIXTURE_DATABASE}.${FIXTURE_METADATA_TABLE}`)
    .values({
      database: undefined,
      schema: MEMBERSHIP_FIXTURE_DATABASE,
      table: USER_GROUPS_TABLE,
      type: 'GENERATED_COLUMN',
      name: 'is_pure_profile_group',
      value: source
        .getMetadata(UserGroupEntity)
        .findColumnWithPropertyName('is_pure_profile_group')!.asExpression
    })
    .getQueryAndParameters();
}
export async function inspectFixtureMetadata(
  source: DataSource,
  runner: QueryRunner
): Promise<boolean> {
  const tables: { engine: string; collation: string }[] = await runner.query(
    'SELECT ENGINE engine,TABLE_COLLATION collation FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [FIXTURE_METADATA_TABLE]
  );
  if (
    tables.length !== 1 ||
    tables[0].engine !== 'InnoDB' ||
    tables[0].collation !== 'utf8mb4_unicode_ci'
  )
    throw new Error('Fixture TypeORM metadata storage drift');
  const columns: {
    name: string;
    kind: string;
    nullable: string;
    extra: string;
    default_value: unknown;
  }[] = await runner.query(
    'SELECT COLUMN_NAME name,COLUMN_TYPE kind,IS_NULLABLE nullable,EXTRA extra,COLUMN_DEFAULT default_value FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 7',
    [FIXTURE_METADATA_TABLE]
  );
  const names = ['type', 'database', 'schema', 'table', 'name', 'value'];
  if (
    columns.length !== 6 ||
    columns.some(
      (column, index) =>
        column.name !== names[index] ||
        column.kind !== (index === 5 ? 'text' : 'varchar(255)') ||
        column.nullable !== (index === 0 ? 'NO' : 'YES') ||
        column.extra !== '' ||
        column.default_value !== null
    )
  )
    throw new Error('Fixture TypeORM metadata schema drift');
  if (
    (
      await runner.query(
        'SELECT 1 FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1',
        [FIXTURE_METADATA_TABLE]
      )
    ).length
  )
    throw new Error('Unexpected TypeORM metadata indexes');
  const rows: {
    type: string;
    database: string | null;
    schema: string;
    table: string;
    name: string;
    value: string;
  }[] = await runner.query('SELECT * FROM typeorm_metadata LIMIT 2');
  const expression = source
    .getMetadata(UserGroupEntity)
    .findColumnWithPropertyName('is_pure_profile_group')!.asExpression;
  if (
    rows.length > 1 ||
    rows.some(
      (row) =>
        row.type !== 'GENERATED_COLUMN' ||
        row.database !== null ||
        row.schema !== MEMBERSHIP_FIXTURE_DATABASE ||
        row.table !== USER_GROUPS_TABLE ||
        row.name !== 'is_pure_profile_group' ||
        row.value !== expression
    )
  )
    throw new Error('Unknown fixture TypeORM metadata');
  return rows.length === 1;
}

/** Single atomic insert-select tolerates duplicate setup invocations; retry inspects the outcome. */
export function fixtureMetadataRecoveryInsert(source: DataSource): string {
  const expression = source
    .getMetadata(UserGroupEntity)
    .findColumnWithPropertyName('is_pure_profile_group')!.asExpression;
  return format(
    'INSERT INTO typeorm_metadata (`type`,`schema`,`table`,`name`,`value`) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM typeorm_metadata LIMIT 1)',
    [
      'GENERATED_COLUMN',
      MEMBERSHIP_FIXTURE_DATABASE,
      USER_GROUPS_TABLE,
      'is_pure_profile_group',
      expression
    ]
  );
}

function unwrapExpression(value: string): string {
  let expression = value.trim();
  while (expression.startsWith('(')) {
    let depth = 0;
    let closing = -1;
    for (let index = 0; index < expression.length; index++) {
      if (expression[index] === '(') depth++;
      if (expression[index] === ')' && --depth === 0) {
        closing = index;
        break;
      }
    }
    if (closing !== expression.length - 1) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}
function expressionParts(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let after = 0;
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '(') depth++;
    else if (expression[index] === ')') depth--;
    if (depth < 0 || depth > 32)
      throw new Error('Invalid fixture generated expression');
    if (depth === 0 && /^\s+and\s+/i.test(expression.slice(index))) {
      const separator = /^\s+and\s+/i.exec(expression.slice(index))![0];
      parts.push(expression.slice(after, index));
      index += separator.length - 1;
      after = index + 1;
    }
  }
  if (depth !== 0) throw new Error('Invalid fixture generated expression');
  parts.push(expression.slice(after));
  return parts;
}
function expressionAtoms(value: string, depth = 0): string[] {
  if (depth > 32)
    throw new Error('Invalid fixture generated expression nesting');
  const expression = unwrapExpression(value);
  const parts = expressionParts(expression);
  if (parts.length > 1)
    return parts.flatMap((part) => expressionAtoms(part, depth + 1));
  const nullable = /^`?([a-z_]+)`?\s+is\s+(not\s+)?null$/i.exec(expression);
  if (nullable)
    return [`null:${nullable[1].toLowerCase()}:${Boolean(nullable[2])}`];
  const zero = /^coalesce\s*\(\s*`?([a-z_]+)`?\s*,\s*0\s*\)\s*=\s*0$/i.exec(
    expression
  );
  if (zero) return [`zero:${zero[1].toLowerCase()}`];
  throw new Error('Unapproved fixture generated expression atom');
}
export function equalFixtureGeneratedExpression(
  actual: string,
  expected: string
): boolean {
  if (actual.length > 8192 || expected.length > 8192) return false;
  const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  try {
    return (
      JSON.stringify(expressionAtoms(actual).sort(compare)) ===
      JSON.stringify(expressionAtoms(expected).sort(compare))
    );
  } catch {
    return false;
  }
}
export async function assertFixtureGeneratedExpression(
  source: DataSource,
  runner: QueryRunner
): Promise<void> {
  const rows: { expression: string; extra: string }[] = await runner.query(
    'SELECT GENERATION_EXPRESSION expression,EXTRA extra FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [USER_GROUPS_TABLE, 'is_pure_profile_group']
  );
  const expected = source
    .getMetadata(UserGroupEntity)
    .findColumnWithPropertyName('is_pure_profile_group')!.asExpression!;
  if (
    rows.length !== 1 ||
    rows[0].extra !== 'STORED GENERATED' ||
    !equalFixtureGeneratedExpression(rows[0].expression, expected)
  )
    throw new Error(
      'Fixture generated column differs from the reviewed expression'
    );
}
