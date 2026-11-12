import { createHash } from 'node:crypto';

/**
 * Classification of the statements TypeORM's schema builder plans for a
 * schema sync, so statements that remove data or relax a unique key can be
 * reported, and optionally held back until an operator acknowledges them.
 *
 * The parser recognises the statement shapes TypeORM 0.3's MySQL query runner
 * emits (MysqlQueryRunner): CREATE TABLE / VIEW / INDEX, DROP TABLE / VIEW /
 * INDEX, RENAME TABLE, single-clause ALTER TABLE statements, the two
 * two-clause renames (`DROP INDEX a, ADD INDEX b`, `DROP FOREIGN KEY a, ADD
 * CONSTRAINT b`), and its typeorm_metadata bookkeeping. Anything else is
 * treated as destructive, since it cannot be shown to be safe.
 */

export interface PlannedSchemaStatement {
  readonly query: string;
  readonly parameters?: unknown[];
}

export interface SchemaTableRef {
  /** Explicit schema from a `db`.`table` path; null means the current one. */
  readonly schema: string | null;
  readonly name: string;
}

type AlterClause =
  | { readonly op: 'add_column'; readonly column: string }
  | { readonly op: 'drop_column'; readonly column: string }
  | { readonly op: 'change_column'; readonly from: string; readonly to: string }
  | {
      readonly op: 'add_index';
      readonly index: string;
      readonly unique: boolean;
      readonly columns: readonly string[];
    }
  | { readonly op: 'drop_index'; readonly index: string }
  | {
      readonly op: 'rename_index';
      readonly from: string;
      readonly to: string;
      readonly unique: boolean;
      readonly columns: readonly string[];
    }
  | { readonly op: 'add_primary_key'; readonly columns: readonly string[] }
  | { readonly op: 'drop_primary_key' }
  | { readonly op: 'add_foreign_key' }
  | { readonly op: 'drop_foreign_key' }
  | { readonly op: 'rename_foreign_key' }
  | { readonly op: 'comment' }
  | { readonly op: 'unknown' };

export type ParsedSchemaStatement =
  | { readonly op: 'create_table'; readonly table: SchemaTableRef }
  | { readonly op: 'drop_table'; readonly table: SchemaTableRef }
  | { readonly op: 'rename_table' }
  | { readonly op: 'create_view' }
  | { readonly op: 'drop_view' }
  | {
      readonly op: 'create_index';
      readonly table: SchemaTableRef;
      readonly index: string;
      readonly unique: boolean;
      readonly columns: readonly string[];
    }
  | {
      readonly op: 'drop_index';
      readonly table: SchemaTableRef;
      readonly index: string;
    }
  | {
      readonly op: 'alter_table';
      readonly table: SchemaTableRef;
      readonly clause: AlterClause;
    }
  | { readonly op: 'metadata' }
  | { readonly op: 'unknown' };

export type SchemaStatementKind =
  | 'additive'
  | 'in_place'
  | 'bookkeeping'
  | 'destructive';

export interface ClassifiedSchemaStatement extends PlannedSchemaStatement {
  readonly kind: SchemaStatementKind;
  readonly reason: string;
}

export interface SchemaPlanCheck {
  readonly statements: readonly ClassifiedSchemaStatement[];
  readonly destructive: readonly ClassifiedSchemaStatement[];
  /** SHA-256 of the destructive statements, or null when there are none. */
  readonly destructivePlanSha256: string | null;
}

/** Live-schema facts the classification needs for drop statements. */
export interface SchemaCatalog {
  column(
    table: SchemaTableRef,
    column: string
  ): Promise<{ readonly generated: boolean } | null>;
  index(
    table: SchemaTableRef,
    index: string
  ): Promise<{
    readonly unique: boolean;
    readonly columns: readonly string[];
  } | null>;
}

const IDENT = '`([^`]+)`';
const TABLE_PATH = `(?:${IDENT}\\.)?${IDENT}`;
const INDEX_TYPE = '(UNIQUE |FULLTEXT |SPATIAL )?';
const TYPEORM_METADATA_TABLE = 'typeorm_metadata';

function tableRef(
  schema: string | undefined,
  name: string | undefined
): SchemaTableRef {
  return { schema: schema ?? null, name: name ?? '' };
}

function columnList(text: string | undefined): string[] {
  return Array.from((text ?? '').matchAll(/`([^`]+)`/g), (match) => match[1]);
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const ALTER_CLAUSE_PARSERS: ReadonlyArray<
  readonly [RegExp, (match: RegExpExecArray) => AlterClause]
> = [
  [
    new RegExp(
      `^DROP INDEX ${IDENT}, ADD ${INDEX_TYPE}INDEX ${IDENT} \\(([^)]*)\\)`,
      'i'
    ),
    (m) => ({
      op: 'rename_index',
      from: m[1],
      to: m[3],
      unique: (m[2] ?? '').trim().toUpperCase() === 'UNIQUE',
      columns: columnList(m[4])
    })
  ],
  [
    new RegExp(`^DROP FOREIGN KEY ${IDENT}, ADD CONSTRAINT ${IDENT} `, 'i'),
    () => ({ op: 'rename_foreign_key' })
  ],
  [/^DROP PRIMARY KEY$/i, () => ({ op: 'drop_primary_key' })],
  [
    /^ADD PRIMARY KEY \(([^)]*)\)$/i,
    (m) => ({ op: 'add_primary_key', columns: columnList(m[1]) })
  ],
  [
    new RegExp(`^ADD ${INDEX_TYPE}INDEX ${IDENT} \\(([^)]*)\\)`, 'i'),
    (m) => ({
      op: 'add_index',
      index: m[2],
      unique: (m[1] ?? '').trim().toUpperCase() === 'UNIQUE',
      columns: columnList(m[3])
    })
  ],
  [
    new RegExp(`^ADD CONSTRAINT ${IDENT} FOREIGN KEY `, 'i'),
    () => ({ op: 'add_foreign_key' })
  ],
  [
    new RegExp(`^DROP FOREIGN KEY ${IDENT}$`, 'i'),
    () => ({ op: 'drop_foreign_key' })
  ],
  [
    new RegExp(`^DROP INDEX ${IDENT}$`, 'i'),
    (m) => ({ op: 'drop_index', index: m[1] })
  ],
  [
    new RegExp(`^DROP COLUMN ${IDENT}$`, 'i'),
    (m) => ({ op: 'drop_column', column: m[1] })
  ],
  [
    new RegExp(`^CHANGE ${IDENT} ${IDENT} `, 'i'),
    (m) => ({ op: 'change_column', from: m[1], to: m[2] })
  ],
  [
    new RegExp(`^ADD ${IDENT} `, 'i'),
    (m) => ({ op: 'add_column', column: m[1] })
  ],
  [/^COMMENT /i, () => ({ op: 'comment' })]
];

function parseAlterClause(clause: string): AlterClause {
  for (const [pattern, build] of ALTER_CLAUSE_PARSERS) {
    const match = pattern.exec(clause);
    if (match) return build(match);
  }
  return { op: 'unknown' };
}

const STATEMENT_PARSERS: ReadonlyArray<
  readonly [RegExp, (match: RegExpExecArray) => ParsedSchemaStatement]
> = [
  [
    new RegExp(
      `^(?:INSERT INTO|DELETE FROM|UPDATE) ${TABLE_PATH}(?:[ (]|$)`,
      'i'
    ),
    (m) =>
      m[2] === TYPEORM_METADATA_TABLE ? { op: 'metadata' } : { op: 'unknown' }
  ],
  [
    new RegExp(`^CREATE TABLE ${TABLE_PATH} `, 'i'),
    (m) => ({ op: 'create_table', table: tableRef(m[1], m[2]) })
  ],
  [
    new RegExp(`^DROP TABLE ${TABLE_PATH}$`, 'i'),
    (m) => ({ op: 'drop_table', table: tableRef(m[1], m[2]) })
  ],
  [/^RENAME TABLE /i, () => ({ op: 'rename_table' })],
  [/^CREATE VIEW /i, () => ({ op: 'create_view' })],
  [/^DROP VIEW /i, () => ({ op: 'drop_view' })],
  [
    new RegExp(
      `^CREATE ${INDEX_TYPE}INDEX ${IDENT} ON ${TABLE_PATH} \\(([^)]*)\\)`,
      'i'
    ),
    (m) => ({
      op: 'create_index',
      table: tableRef(m[3], m[4]),
      index: m[2],
      unique: (m[1] ?? '').trim().toUpperCase() === 'UNIQUE',
      columns: columnList(m[5])
    })
  ],
  [
    new RegExp(`^DROP INDEX ${IDENT} ON ${TABLE_PATH}$`, 'i'),
    (m) => ({ op: 'drop_index', table: tableRef(m[2], m[3]), index: m[1] })
  ],
  [
    new RegExp(`^ALTER TABLE ${TABLE_PATH} (.+)$`, 'i'),
    (m) => ({
      op: 'alter_table',
      table: tableRef(m[1], m[2]),
      clause: parseAlterClause(m[3])
    })
  ]
];

/** Recognises one planned statement; only its leading clause is inspected. */
export function parseSchemaStatement(sql: string): ParsedSchemaStatement {
  const text = normalise(sql);
  for (const [pattern, build] of STATEMENT_PARSERS) {
    const match = pattern.exec(text);
    if (match) return build(match);
  }
  return { op: 'unknown' };
}

const sameTable = (a: SchemaTableRef, b: SchemaTableRef) =>
  a.name === b.name && a.schema === b.schema;

const sameColumns = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((column, i) => column === b[i]);

/** Unique indexes and primary keys the plan creates, per table. */
function uniqueKeysCreated(parsed: readonly ParsedSchemaStatement[]) {
  const keys: {
    table: SchemaTableRef;
    primary: boolean;
    columns: readonly string[];
  }[] = [];
  for (const statement of parsed) {
    if (statement.op === 'create_index' && statement.unique) {
      keys.push({
        table: statement.table,
        primary: false,
        columns: statement.columns
      });
    } else if (statement.op === 'alter_table') {
      const { clause } = statement;
      if (
        (clause.op === 'add_index' || clause.op === 'rename_index') &&
        clause.unique
      ) {
        keys.push({
          table: statement.table,
          primary: false,
          columns: clause.columns
        });
      } else if (clause.op === 'add_primary_key') {
        keys.push({
          table: statement.table,
          primary: true,
          columns: clause.columns
        });
      }
    }
  }
  return keys;
}

type Verdict = { kind: SchemaStatementKind; reason: string };

const additive = (reason: string): Verdict => ({ kind: 'additive', reason });
const inPlace = (reason: string): Verdict => ({ kind: 'in_place', reason });
const destructive = (reason: string): Verdict => ({
  kind: 'destructive',
  reason
});

async function classifyDropIndex(
  table: SchemaTableRef,
  index: string,
  recreated: ReturnType<typeof uniqueKeysCreated>,
  catalog: SchemaCatalog
): Promise<Verdict> {
  const live = await catalog.index(table, index);
  if (!live) return destructive(`drops index ${index}, not found in catalog`);
  if (!live.unique) return inPlace(`drops non-unique index ${index}`);
  const replaced = recreated.some(
    (key) =>
      !key.primary &&
      sameTable(key.table, table) &&
      sameColumns(key.columns, live.columns)
  );
  return replaced
    ? inPlace(`replaces unique index ${index} on the same columns`)
    : destructive(`drops unique index ${index}`);
}

async function classifyAlter(
  table: SchemaTableRef,
  clause: AlterClause,
  recreated: ReturnType<typeof uniqueKeysCreated>,
  catalog: SchemaCatalog
): Promise<Verdict> {
  switch (clause.op) {
    case 'add_column':
      return additive(`adds column ${clause.column}`);
    case 'add_index':
      return additive(`adds index ${clause.index}`);
    case 'add_primary_key':
      return additive('adds primary key');
    case 'add_foreign_key':
      return additive('adds foreign key');
    case 'comment':
      return additive('changes table comment');
    case 'change_column':
      return inPlace(
        clause.from === clause.to
          ? `changes column ${clause.from} in place`
          : `renames column ${clause.from} to ${clause.to}`
      );
    case 'rename_index':
      return inPlace(`renames index ${clause.from} to ${clause.to}`);
    case 'rename_foreign_key':
      return inPlace('renames foreign key');
    case 'drop_foreign_key':
      return inPlace('drops foreign key');
    case 'drop_index':
      return classifyDropIndex(table, clause.index, recreated, catalog);
    case 'drop_column': {
      const live = await catalog.column(table, clause.column);
      if (live?.generated) {
        return inPlace(`drops generated column ${clause.column}`);
      }
      return destructive(`drops column ${clause.column}`);
    }
    case 'drop_primary_key': {
      const live = await catalog.index(table, 'PRIMARY');
      const replaced =
        !!live &&
        recreated.some(
          (key) =>
            key.primary &&
            sameTable(key.table, table) &&
            sameColumns(key.columns, live.columns)
        );
      return replaced
        ? inPlace('replaces primary key on the same columns')
        : destructive('drops primary key');
    }
    case 'unknown':
      return destructive('unrecognised ALTER TABLE clause');
  }
}

async function classifyParsed(
  statement: ParsedSchemaStatement,
  recreated: ReturnType<typeof uniqueKeysCreated>,
  catalog: SchemaCatalog
): Promise<Verdict> {
  switch (statement.op) {
    case 'create_table':
      return additive(`creates table ${statement.table.name}`);
    case 'create_view':
      return additive('creates view');
    case 'create_index':
      return additive(`creates index ${statement.index}`);
    case 'drop_view':
      return inPlace('drops view');
    case 'metadata':
      return { kind: 'bookkeeping', reason: 'TypeORM metadata bookkeeping' };
    case 'drop_index':
      return classifyDropIndex(
        statement.table,
        statement.index,
        recreated,
        catalog
      );
    case 'alter_table':
      return classifyAlter(
        statement.table,
        statement.clause,
        recreated,
        catalog
      );
    case 'drop_table':
      return destructive(`drops table ${statement.table.name}`);
    case 'rename_table':
      return destructive('renames a table');
    case 'unknown':
      return destructive('unrecognised statement');
  }
}

/** Stable digest of the destructive statements, in plan order. */
export function destructivePlanSha256(
  destructiveStatements: readonly PlannedSchemaStatement[]
): string | null {
  if (!destructiveStatements.length) return null;
  return createHash('sha256')
    .update(
      JSON.stringify(
        destructiveStatements.map((it) => [it.query, it.parameters ?? []])
      )
    )
    .digest('hex');
}

export async function checkSchemaPlan(
  planned: readonly PlannedSchemaStatement[],
  catalog: SchemaCatalog
): Promise<SchemaPlanCheck> {
  const parsed = planned.map((it) => parseSchemaStatement(it.query));
  const recreated = uniqueKeysCreated(parsed);
  const statements: ClassifiedSchemaStatement[] = [];
  for (let i = 0; i < planned.length; i++) {
    const verdict = await classifyParsed(parsed[i], recreated, catalog);
    statements.push({ ...planned[i], ...verdict });
  }
  const destructiveStatements = statements.filter(
    (it) => it.kind === 'destructive'
  );
  return {
    statements,
    destructive: destructiveStatements,
    destructivePlanSha256: destructivePlanSha256(destructiveStatements)
  };
}

type Query = (sql: string, parameters?: unknown[]) => Promise<unknown>;

/** Catalog lookups through the sync's own connection (information_schema). */
export function informationSchemaCatalog(query: Query): SchemaCatalog {
  return {
    async column(table, column) {
      const rows = (await query(
        `select GENERATION_EXPRESSION as generation_expression
         from information_schema.COLUMNS
         where TABLE_SCHEMA = coalesce(?, database())
           and TABLE_NAME = ? and COLUMN_NAME = ?`,
        [table.schema, table.name, column]
      )) as { generation_expression?: unknown }[] | undefined;
      if (!rows?.length) return null;
      const expression = rows[0].generation_expression;
      return { generated: typeof expression === 'string' && expression !== '' };
    },
    async index(table, index) {
      const rows = (await query(
        `select NON_UNIQUE as non_unique, COLUMN_NAME as column_name
           from information_schema.STATISTICS
           where TABLE_SCHEMA = coalesce(?, database())
             and TABLE_NAME = ? and INDEX_NAME = ?
           order by SEQ_IN_INDEX`,
        [table.schema, table.name, index]
      )) as { non_unique?: unknown; column_name?: unknown }[] | undefined;
      if (!rows?.length) return null;
      return {
        unique: Number(rows[0].non_unique) === 0,
        columns: rows.map((row) => String(row.column_name))
      };
    }
  };
}

export const SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV =
  'SCHEMA_SYNC_DESTRUCTIVE_GUARD';

export type SchemaSyncDestructiveGuardMode = 'report' | 'block';

/**
 * Reads a SCHEMA_SYNC_DESTRUCTIVE_GUARD value (trimmed, case-insensitive).
 * `block` holds back a plan with destructive statements unless it is
 * acknowledged; `report`, or no value, only reports such plans. Any other
 * value is a configuration error: it throws, so the sync does not start.
 */
export function schemaSyncDestructiveGuardMode(
  value: string | undefined
): SchemaSyncDestructiveGuardMode {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '' || normalized === 'report') return 'report';
  if (normalized === 'block') return 'block';
  throw new Error(
    `${SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV} must be "report" or "block" (or unset for "report"), got ${JSON.stringify(value)}`
  );
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function isDestructivePlanAcknowledgement(value: unknown): boolean {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export type DestructivePlanDecision =
  | 'none'
  | 'reported'
  | 'acknowledged'
  | 'refused';

export function destructivePlanDecision(
  check: Pick<SchemaPlanCheck, 'destructivePlanSha256'>,
  {
    mode,
    acknowledgedSha256
  }: {
    readonly mode: SchemaSyncDestructiveGuardMode;
    readonly acknowledgedSha256?: string | null;
  }
): DestructivePlanDecision {
  if (check.destructivePlanSha256 === null) return 'none';
  if (mode === 'report') return 'reported';
  return acknowledgedSha256 === check.destructivePlanSha256
    ? 'acknowledged'
    : 'refused';
}
