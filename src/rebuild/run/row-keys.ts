import { ColumnInfo, MysqlAdmin } from '@/rebuild/stack/mysql-admin';

/**
 * A scoped volatile column after the comparison: the rows its condition
 * matched on each side, of how many, and the rows on both sides it matched
 * on one side only (compared there, so they show as changed).
 */
export interface ScopeTally {
  readonly column: string;
  readonly before: number;
  readonly after: number;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly oneSide: number;
}

/** What rowKeyProblems needs to know of a table's schema. */
export interface RowKeyFacts {
  readonly primaryKey: readonly string[];
  /** Every UNIQUE index, the primary key among them, as its columns. */
  readonly uniqueKeys: readonly (readonly string[])[];
  readonly columns: readonly ColumnInfo[];
}

export async function rowKeyFacts(
  admin: MysqlAdmin,
  database: string,
  table: string
): Promise<RowKeyFacts> {
  return {
    primaryKey: await admin.primaryKey(database, table),
    uniqueKeys: await admin.uniqueKeys(database, table),
    columns: await admin.columnInfo(database, table)
  };
}

/** The same columns, in any order. */
const sameColumns = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((column) => b.includes(column));

/**
 * Why a table's declared rowKey or scoped volatile columns can't hold
 * against its schema, at run start, and what to note:
 * - a rowKey must name columns the table has, spelt as the schema spells
 *   them (rows come back under those names), all NOT NULL, that are
 *   exactly a UNIQUE index of it (MySQL lets a unique index hold several
 *   NULLs, and a key two rows share would match the wrong row); a rowKey
 *   that is the primary key is noted, as it changes nothing;
 * - a scoped volatile column must be a column of the table, spelt as the
 *   schema spells it, and the row key (the rowKey, else the primary key)
 *   must be there without it or any column the comparison leaves out of
 *   every row (`unstable`): a key that changes can't say which row is
 *   which, so a row its condition matched on one side only couldn't be
 *   told from two different rows.
 */
export function rowKeyProblems(input: {
  readonly table: string;
  readonly rowKey?: readonly string[];
  readonly primaryKey: readonly string[];
  readonly uniqueKeys: readonly (readonly string[])[];
  readonly columns: readonly ColumnInfo[];
  readonly scoped: readonly { readonly column: string }[];
  /** Columns left out of every row: volatile, exempt, owned by an absent owner. */
  readonly unstable: readonly string[];
}): { problems: string[]; notes: string[] } {
  const { table, rowKey, primaryKey } = input;
  const problems: string[] = [];
  const notes: string[] = [];
  const names = input.columns.map((column) => column.name);
  /** Why `name` isn't a column as the schema spells it, or null. */
  const unknown = (name: string): string | null => {
    if (names.includes(name)) return null;
    const spelt = names.find((n) => n.toLowerCase() === name.toLowerCase());
    return spelt
      ? `${name}, which the schema spells ${spelt}`
      : `${name}, which the schema doesn't have`;
  };
  if (rowKey) {
    const missing = rowKey.map(unknown).filter((why) => why !== null);
    const nullable = rowKey.filter(
      (c) => input.columns.find((column) => column.name === c)?.nullable
    );
    if (missing.length) {
      problems.push(`${table}'s rowKey names ${missing.join('; ')}`);
    } else if (!input.uniqueKeys.some((key) => sameColumns(key, rowKey))) {
      problems.push(
        `${table}'s rowKey (${rowKey.join(', ')}) is no UNIQUE index of the table: two rows could share it`
      );
    } else if (nullable.length) {
      problems.push(
        `${table}'s rowKey holds ${nullable.join(', ')}, which may be NULL: a UNIQUE index lets rows share a NULL`
      );
    } else if (sameColumns(primaryKey, rowKey)) {
      notes.push(
        `${table}'s rowKey is its primary key: declaring it changes nothing`
      );
    }
  }
  const key = rowKey ?? primaryKey;
  const keyName = rowKey ? 'declared row key' : 'primary key';
  const hint = rowKey ? '' : ' (declare a rowKey without it)';
  const unstableKey = key.filter((c) => input.unstable.includes(c));
  for (const { column } of input.scoped) {
    const missing = unknown(column);
    if (missing) {
      problems.push(
        `${table}.${column} is volatile where a condition holds, but it names ${missing}`
      );
    } else if (!key.length) {
      problems.push(
        `${table}.${column} is volatile where a condition holds, but the table has no row key to tell which row it left out (declare a rowKey)`
      );
    } else if (key.includes(column)) {
      problems.push(
        `${table}.${column} is volatile where a condition holds, but it is in the table's ${keyName}${hint}: rows are found by that key`
      );
    } else if (unstableKey.length) {
      problems.push(
        `${table}.${column} is volatile where a condition holds, but the table's ${keyName} holds ${unstableKey.join(', ')}, which the comparison leaves out of every row${hint}: rows are found by that key`
      );
    }
  }
  return { problems, notes };
}
