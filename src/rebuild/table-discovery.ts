import * as fs from 'node:fs';
import * as path from 'node:path';
import 'reflect-metadata';
import { DefaultNamingStrategy, getMetadataArgsStorage } from 'typeorm';
import * as Entities from '@/entities/entities';
import { RETIRED_COMPETITION_TABLES } from '@/competitions/retired-competition-storage';
import { RETIRED_MEMBERSHIP_TABLES } from '@/dbMigrationsLoop/retired-schema-cleanup';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from '@/competitions/legacy-competition-get-facade';

/** Where code names a table. */
export type CodeOrigin = 'entity' | 'constant' | 'retired' | 'view';

export type CodeTables = ReadonlyMap<string, ReadonlySet<CodeOrigin>>;

export interface LiveTable {
  readonly name: string;
  readonly type: 'BASE TABLE' | 'VIEW';
}

/** Every string export of this file names a table, except `*_PREFIX`. */
const TABLE_CONSTANTS_FILE = path.join('constants', 'db-tables.ts');
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'generated',
  'tests'
]);
const STRING_EXPORT =
  /export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*(['"`])([a-z0-9_]+)\2\s*;/g;

/** Tables of the entities the schema build creates (`src/entities/entities.ts`). */
export function entityTableNames(): string[] {
  const targets = new Set<unknown>(
    Object.values(Entities).filter((entity) => typeof entity === 'function')
  );
  const naming = new DefaultNamingStrategy();
  return getMetadataArgsStorage()
    .tables.filter((table) => targets.has(table.target))
    .map((table) =>
      naming.tableName(
        typeof table.target === 'function' ? table.target.name : '',
        table.name
      )
    );
}

/**
 * Table names a source file exports as string constants: every export of
 * `constants/db-tables.ts` except `*_PREFIX`, and `*_TABLE` exports elsewhere.
 */
export function scanTableConstants(
  source: string,
  isTableConstantsFile: boolean
): string[] {
  const names: string[] = [];
  for (const match of Array.from(source.matchAll(STRING_EXPORT))) {
    const [, constant, , value] = match;
    const named = isTableConstantsFile
      ? !constant.endsWith('_PREFIX')
      : constant.endsWith('_TABLE');
    if (named) names.push(value);
  }
  return names;
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) sourceFiles(full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Table names exported as constants anywhere under `srcRoot`. */
export function constantTableNames(
  srcRoot: string = path.resolve(__dirname, '..')
): string[] {
  const constantsFile = path.join(srcRoot, TABLE_CONSTANTS_FILE);
  return sourceFiles(srcRoot).flatMap((file) =>
    scanTableConstants(fs.readFileSync(file, 'utf8'), file === constantsFile)
  );
}

/** Names code retired: no table in a fresh schema. */
export function retiredTableNames(): string[] {
  return [...RETIRED_COMPETITION_TABLES, ...RETIRED_MEMBERSHIP_TABLES];
}

/** The competition facade's views, which the schema build creates. */
export function viewNames(): string[] {
  return LEGACY_GET_SOURCE_TABLES.map((table) => legacyGetView(table));
}

/** Every table or view name code knows, with where it is named. */
export function discoverCodeTables(): CodeTables {
  const tables = new Map<string, Set<CodeOrigin>>();
  const add = (names: string[], origin: CodeOrigin) => {
    for (const name of names) {
      const origins = tables.get(name) ?? new Set<CodeOrigin>();
      origins.add(origin);
      tables.set(name, origins);
    }
  };
  add(entityTableNames(), 'entity');
  add(constantTableNames(), 'constant');
  add(retiredTableNames(), 'retired');
  add(viewNames(), 'view');
  return tables;
}

/** The tables and views of one schema, from `information_schema`. */
export async function liveSchemaTables(
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
  database: string
): Promise<LiveTable[]> {
  const rows = await query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME`,
    [database]
  );
  return rows.map((row) => ({
    name: String(row.name),
    type: row.type === 'VIEW' ? 'VIEW' : 'BASE TABLE'
  }));
}
