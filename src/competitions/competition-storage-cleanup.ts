/** Operator-only physical cleanup. Never imported by application/schema handlers. */
import { createHash } from 'node:crypto';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from './legacy-competition-get-facade';
import type { QueryRunner } from 'typeorm';
import {
  RETIRED_COMPETITION_COLUMNS,
  RETIRED_COMPETITION_TABLES
} from './retired-competition-storage';

export const DELETED_WAVE_COMPETITION_ORPHANS = [
  {
    wave: '2e156526-042d-4b6c-9691-17c0cdd0bb9d',
    competition: '0e2fc368-7a48-5bf4-ab5b-1738fa98e7fb'
  },
  {
    wave: 'd6392f2d-3110-49ea-953b-110aa2096f35',
    competition: '92111347-0318-5c35-ad59-6f82a5417dab'
  },
  {
    wave: 'fbb1ab73-cec6-4430-a120-c916d8324cee',
    competition: '9afbb5a9-9235-56e4-8aef-9c34153721f5'
  },
  {
    wave: '5a8f7453-c2f9-4d24-8d38-70b7eadd447e',
    competition: 'f15f11c5-22c4-56c7-bc08-59c1572031ba'
  }
] as const;

export interface CompetitionCleanupInventory {
  database: string;
  serverUuid: string;
  sharedDefinitions: { name: string; definition: string }[];
  tables: {
    name: string;
    definition: string;
    rows: string;
    checksum: string;
  }[];
  columns: { table: string; name: string; definition: string }[];
  indexes: { table: string; name: string; columns: string }[];
}

export const cleanupDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_]+$/.test(value))
    throw new Error('Invalid cleanup identifier');
  return `\`${value}\``;
};
const placeholders = (values: readonly unknown[]): string =>
  values.map(() => '?').join(',');

async function assertNoPhysicalDependencies(runner: QueryRunner) {
  const tables = [...RETIRED_COMPETITION_TABLES];
  const dependencies: { name: string }[] = await runner.query(
    `select concat(VIEW_SCHEMA,'.',VIEW_NAME) as name from information_schema.VIEW_TABLE_USAGE
     where TABLE_SCHEMA=database() and TABLE_NAME in (${placeholders(tables)})
     union all select concat(TABLE_SCHEMA,'.',TABLE_NAME) from information_schema.KEY_COLUMN_USAGE
     where REFERENCED_TABLE_SCHEMA=database() and REFERENCED_TABLE_NAME in (${placeholders(tables)})`,
    [...tables, ...tables]
  );
  const programs: { definition: string | null }[] = await runner.query(
    `select ROUTINE_DEFINITION as definition from information_schema.ROUTINES where ROUTINE_SCHEMA=database()
     union all select ACTION_STATEMENT from information_schema.TRIGGERS where TRIGGER_SCHEMA=database()
     union all select EVENT_DEFINITION from information_schema.EVENTS where EVENT_SCHEMA=database()`
  );
  const retired = new RegExp(`\\b(${tables.join('|')})\\b`, 'i');
  if (
    dependencies.length ||
    programs.some(
      ({ definition }) => definition === null || retired.test(definition)
    )
  )
    throw new Error(
      'Retired storage has physical dependencies or unreadable stored programs'
    );
  const names = LEGACY_GET_SOURCE_TABLES.map(legacyGetView);
  const unknown: unknown[] = await runner.query(
    `select VIEW_NAME from information_schema.VIEW_TABLE_USAGE where TABLE_SCHEMA=database()
     and TABLE_NAME in ('waves','waves_archive','competitions') and VIEW_NAME not in (${placeholders(names)})`,
    names
  );
  if (unknown.length)
    throw new Error(
      'An unreviewed view depends on the tables losing retired columns'
    );
  const views: { name: string; definition: string | null }[] =
    await runner.query(
      `select TABLE_NAME as name,VIEW_DEFINITION as definition from information_schema.VIEWS
     where TABLE_SCHEMA=database() and TABLE_NAME in (${placeholders(names)})`,
      names
    );
  const physicalWaveField = new RegExp(
    `\\bw\\.(${RETIRED_COMPETITION_COLUMNS.waves.join('|')})\\b`,
    'i'
  );
  if (
    views.length !== names.length ||
    views.some(
      ({ definition }) =>
        definition === null ||
        !/(^|[^a-z_0-9])competitions([^a-z_0-9]|$)/i.test(definition) ||
        /\.\s*`?storage_mode`?\b/i.test(definition) ||
        physicalWaveField.test(definition.replace(/`/g, ''))
    )
  )
    throw new Error(
      'Deploy and maintain all native compatibility views before physical cleanup'
    );
}

/** Inventory includes exact DDL/count/checksum and indexes affected by column
 * deletion. Only inert tables are checksummed; shared tables are never locked. */
export async function inspectCompetitionStorage(
  runner: QueryRunner
): Promise<CompetitionCleanupInventory> {
  const [identity]: { database: string; serverUuid: string }[] =
    await runner.query(
      'select database() as `database`,@@server_uuid as serverUuid'
    );
  identifier(identity.database);
  const objects: { name: string; kind: string; engine: string }[] =
    await runner.query(
      `select TABLE_NAME as name,TABLE_TYPE as kind,ENGINE as engine from information_schema.TABLES
     where TABLE_SCHEMA=database() and TABLE_NAME in (${placeholders(RETIRED_COMPETITION_TABLES)}) order by TABLE_NAME`,
      [...RETIRED_COMPETITION_TABLES]
    );
  if (
    objects.some(
      ({ kind, engine }) => kind !== 'BASE TABLE' || engine !== 'InnoDB'
    )
  )
    throw new Error('Unexpected physical retirement object kind or engine');
  const tables: CompetitionCleanupInventory['tables'] = [];
  for (const { name } of objects) {
    const [ddl]: { 'Create Table': string }[] = await runner.query(
      `show create table ${identifier(name)}`
    );
    const [count]: { count: string }[] = await runner.query(
      `select cast(count(*) as char) as count from ${identifier(name)}`
    );
    const [checksum]: { Checksum: number | string | null }[] =
      await runner.query(`checksum table ${identifier(name)} extended`);
    if (checksum.Checksum === null)
      throw new Error('Retired table checksum is unavailable');
    tables.push({
      name,
      definition: ddl['Create Table'],
      rows: count.count,
      checksum: String(checksum.Checksum)
    });
  }
  const sharedDefinitions: CompetitionCleanupInventory['sharedDefinitions'] =
    [];
  const columns: CompetitionCleanupInventory['columns'] = [];
  const indexes: CompetitionCleanupInventory['indexes'] = [];
  for (const [table, retired] of Object.entries(RETIRED_COMPETITION_COLUMNS)) {
    const [definition]: { 'Create Table': string }[] = await runner.query(
      `show create table ${identifier(table)}`
    );
    sharedDefinitions.push({
      name: table,
      definition: definition['Create Table'].replace(
        / AUTO_INCREMENT=\d+\b/,
        ''
      )
    });
    const metadata: {
      Field: string;
      Type: string;
      Null: string;
      Default: string | null;
      Extra: string;
    }[] = await runner.query(`show columns from ${identifier(table)}`);
    for (const column of metadata.filter(({ Field }) =>
      retired.includes(Field)
    ))
      columns.push({
        table,
        name: column.Field,
        definition: JSON.stringify({
          type: column.Type,
          nullable: column.Null,
          default: column.Default,
          extra: column.Extra
        })
      });
    const affected: { name: string; columns: string }[] = await runner.query(
      `select INDEX_NAME as name,group_concat(COLUMN_NAME order by SEQ_IN_INDEX) as columns
       from information_schema.STATISTICS where TABLE_SCHEMA=database() and TABLE_NAME=?
       group by INDEX_NAME having sum(COLUMN_NAME in (${placeholders(retired)}))>0 order by INDEX_NAME`,
      [table, ...retired]
    );
    if (affected.some(({ name }) => name === 'PRIMARY'))
      throw new Error('Retired column participates in a primary key');
    indexes.push(...affected.map((index) => ({ table, ...index })));
  }
  return { ...identity, sharedDefinitions, tables, columns, indexes };
}

async function hasStorageSelector(runner: QueryRunner): Promise<boolean> {
  const rows: unknown[] = await runner.query(
    "select 1 from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME='competitions' and COLUMN_NAME='storage_mode'"
  );
  return rows.length > 0;
}

export async function prepareCompetitionStorage(runner: QueryRunner) {
  if (!(await hasStorageSelector(runner))) return;
  const legacy: { count: string }[] = await runner.query(
    "select cast(count(*) as char) as count from competitions where storage_mode<>'NATIVE'"
  );
  if (Number(legacy[0].count))
    throw new Error(
      'Clean audited deleted-wave orphans before removing storage guards'
    );
  await runner.query(
    "alter table competitions alter column storage_mode set default 'NATIVE', algorithm=instant"
  );
}

/** DDL commits independently in MySQL. No retries or fallback to COPY/locking
 * algorithms; a failure requires inspection of the recorded partial result. */
export async function dropCompetitionStorage(
  runner: QueryRunner,
  approved: CompetitionCleanupInventory
) {
  await runner.query('set session lock_wait_timeout=5');
  await runner.query('set session innodb_lock_wait_timeout=5');
  await runner.query('set session max_execution_time=10000');
  const current = await inspectCompetitionStorage(runner);
  if (cleanupDigest(current) !== cleanupDigest(approved))
    throw new Error(
      'Physical cleanup inventory changed; refresh the reviewed plan'
    );
  await assertNoPhysicalDependencies(runner);
  if (await hasStorageSelector(runner)) {
    const [selectors]: { count: string }[] = await runner.query(
      "select cast(count(*) as char) as count from competitions where storage_mode<>'NATIVE'"
    );
    if (Number(selectors.count))
      throw new Error('Non-native competition rows remain');
  }
  for (const [table, retired] of Object.entries(RETIRED_COMPETITION_COLUMNS)) {
    const indexes = approved.indexes.filter((index) => index.table === table);
    if (indexes.length)
      await runner.query(
        `alter table ${identifier(table)} ${indexes.map(({ name }) => `drop index ${identifier(name)}`).join(',')}, algorithm=inplace, lock=none`
      );
    const columns = approved.columns.filter(
      (column) => column.table === table && retired.includes(column.name)
    );
    if (columns.length)
      await runner.query(
        `alter table ${identifier(table)} ${columns.map(({ name }) => `drop column ${identifier(name)}`).join(',')}, algorithm=instant`
      );
  }
  for (const { name } of approved.tables)
    await runner.query(`drop table ${identifier(name)}`);
  const after = await inspectCompetitionStorage(runner);
  if (after.tables.length || after.columns.length || after.indexes.length)
    throw new Error('Physical cleanup is incomplete');
  return {
    tables: approved.tables.map(({ name }) => name),
    columns: approved.columns.map(({ table, name }) => `${table}.${name}`)
  };
}

const orphanTargets = [
  {
    table: 'competition_config_versions',
    column: 'competition_id',
    kind: 'competition'
  },
  { table: 'wave_dropper_metrics', column: 'wave_id', kind: 'wave' },
  { table: 'wave_reader_metrics', column: 'wave_id', kind: 'wave' },
  { table: 'wave_decision_winner_drops', column: 'wave_id', kind: 'wave' },
  { table: 'wave_decisions', column: 'wave_id', kind: 'wave' },
  { table: 'winner_drop_voter_votes', column: 'wave_id', kind: 'wave' },
  { table: 'wave_voting_credit_nfts_archive', column: 'wave_id', kind: 'wave' },
  { table: 'competitions', column: 'id', kind: 'competition' }
] as const;

async function assertNoUnexpectedOrphanReferences(runner: QueryRunner) {
  const columns: { table_name: string; column_name: string }[] =
    await runner.query(
      `select c.TABLE_NAME as table_name,c.COLUMN_NAME as column_name
     from information_schema.COLUMNS c join information_schema.TABLES t
       on t.TABLE_SCHEMA=c.TABLE_SCHEMA and t.TABLE_NAME=c.TABLE_NAME
     where c.TABLE_SCHEMA=database() and t.TABLE_TYPE='BASE TABLE'
       and c.COLUMN_NAME in ('competition_id','wave_id','legacy_wave_id')
     order by c.TABLE_NAME,c.ORDINAL_POSITION`
    );
  const expected = new Set<string>([
    ...RETIRED_COMPETITION_TABLES,
    ...orphanTargets.map(({ table }) => table),
    'profile_activity_logs',
    'deleted_drops',
    'waves_archive'
  ]);
  const grouped = new Map<string, string[]>();
  for (const { table_name, column_name } of columns) {
    if (expected.has(table_name)) continue;
    grouped.set(table_name, [...(grouped.get(table_name) ?? []), column_name]);
  }
  for (const [table, names] of Array.from(grouped.entries())) {
    const predicates = names.map(
      (name) =>
        `${identifier(name)} in (${placeholders(DELETED_WAVE_COMPETITION_ORPHANS)})`
    );
    const values = names.flatMap((name) =>
      DELETED_WAVE_COMPETITION_ORPHANS.map((row) =>
        name === 'competition_id' ? row.competition : row.wave
      )
    );
    const references: unknown[] = await runner.query(
      `select 1 from ${identifier(table)} where ${predicates.join(' or ')} limit 1`,
      values
    );
    if (references.length)
      throw new Error(
        `Unexpected orphan references in ${table}; inspect before cleanup`
      );
  }
}

export async function inspectCompetitionOrphans(
  runner: QueryRunner,
  auditDependencies = true
) {
  const waves = DELETED_WAVE_COMPETITION_ORPHANS.map(({ wave }) => wave);
  const ids = DELETED_WAVE_COMPETITION_ORPHANS.map(
    ({ competition }) => competition
  );
  const live: unknown[] = await runner.query(
    `select id from waves where id in (${placeholders(waves)})`,
    waves
  );
  if (live.length)
    throw new Error('An approved orphan wave exists; stop targeted cleanup');
  const selector = await hasStorageSelector(runner);
  const owners: {
    id: string;
    wave_id: string;
    legacy_wave_id: string | null;
    storage_mode?: string;
  }[] = await runner.query(
    `select id,wave_id,legacy_wave_id${selector ? ',storage_mode' : ''} from competitions where id in (${placeholders(ids)})`,
    ids
  );
  if (
    owners.some((owner) => {
      const expected = DELETED_WAVE_COMPETITION_ORPHANS.find(
        ({ competition }) => competition === owner.id
      );
      return (
        !expected ||
        owner.wave_id !== expected.wave ||
        owner.legacy_wave_id !== expected.wave ||
        owner.storage_mode !== 'LEGACY_ADAPTER'
      );
    })
  )
    throw new Error(
      'An approved orphan changed its immutable mapping or native ownership'
    );
  if (auditDependencies) await assertNoUnexpectedOrphanReferences(runner);
  const protectedDrop = '3e6067d1-51ff-4909-9e5f-28c69e486af4';
  for (const table of [
    'minting_claims',
    'meme_card_drop_mappings',
    'competition_entries'
  ]) {
    const references: unknown[] = await runner.query(
      `select drop_id from ${identifier(table)} where drop_id=? limit 1`,
      [protectedDrop]
    );
    if (references.length)
      throw new Error(
        'Historical orphan winner has current claims, card ownership or native membership'
      );
  }
  const present: { name: string }[] = await runner.query(
    `select TABLE_NAME as name from information_schema.TABLES where TABLE_SCHEMA=database() and TABLE_TYPE='BASE TABLE' and TABLE_NAME in (${placeholders(orphanTargets)})`,
    orphanTargets.map(({ table }) => table)
  );
  const rows: { table: string; rows: Record<string, unknown>[] }[] = [];
  for (const target of orphanTargets) {
    const values = target.kind === 'wave' ? waves : ids;
    const source: Record<string, unknown>[] = present.some(
      ({ name }) => name === target.table
    )
      ? await runner.query(
          `select * from ${identifier(target.table)} where ${identifier(target.column)} in (${placeholders(values)})`,
          values
        )
      : [];
    rows.push({
      table: target.table,
      rows: source.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
    });
  }
  return rows;
}

export async function deleteCompetitionOrphans(
  runner: QueryRunner,
  approved: Awaited<ReturnType<typeof inspectCompetitionOrphans>>
) {
  await runner.query('set session innodb_lock_wait_timeout=5');
  const audited = await inspectCompetitionOrphans(runner);
  if (cleanupDigest(audited) !== cleanupDigest(approved))
    throw new Error(
      'Orphan records changed; refresh the reviewed backup and plan'
    );
  await runner.startTransaction();
  try {
    const ids = DELETED_WAVE_COMPETITION_ORPHANS.map(
      ({ competition }) => competition
    );
    await runner.query(
      `select id from competitions where id in (${placeholders(ids)}) order by id for update`,
      ids
    );
    const current = await inspectCompetitionOrphans(runner, false);
    if (cleanupDigest(current) !== cleanupDigest(approved))
      throw new Error(
        'Orphan records changed; refresh the reviewed backup and plan'
      );
    for (const target of orphanTargets) {
      const expected = approved.find(({ table }) => table === target.table);
      if (!expected || expected.rows.length > 100)
        throw new Error('Targeted orphan row bound exceeded');
      if (!expected.rows.length) continue;
      const values = DELETED_WAVE_COMPETITION_ORPHANS.map(
        (row) => row[target.kind]
      );
      const result: { affectedRows: number } = await runner.query(
        `delete from ${identifier(target.table)} where ${identifier(target.column)} in (${placeholders(values)}) limit 100`,
        values
      );
      if (result.affectedRows !== expected.rows.length)
        throw new Error('Targeted orphan deletion count changed');
    }
    const remaining = await inspectCompetitionOrphans(runner, false);
    if (remaining.some(({ rows }) => rows.length > 0))
      throw new Error('Targeted orphan cleanup left obsolete records');
    await runner.commitTransaction();
    return approved.map(({ table, rows }) => ({ table, deleted: rows.length }));
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}
