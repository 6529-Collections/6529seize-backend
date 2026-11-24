import { TableEntry } from '@/rebuild/manifest.types';
import { ColumnInfo, resetValue } from '@/rebuild/stack/mysql-admin';

/** A rebuilder that owns columns of a table another rebuilder writes. */
export interface ColumnOwner {
  readonly step: string;
  readonly columns: readonly string[];
}

/**
 * The columns the row comparison leaves out of a table, volatile and
 * exempt alike: a primary key holding one changes on a rebuild.
 */
export function unstableColumns(entry: TableEntry | undefined): string[] {
  return [
    ...(entry?.volatileColumns ?? []),
    ...(entry?.exemptColumns ?? [])
  ].map((c) => c.column);
}

/** Whether MySQL computes a column from others (virtual or stored). */
function generated(column: ColumnInfo): boolean {
  return /VIRTUAL GENERATED|STORED GENERATED/i.test(column.extra);
}

/**
 * Why a table's column owners can't run, at run start. The run carries
 * owned columns across a rebuild by the primary key, so the table needs
 * one, and none of its columns may be volatile or exempt (unstableColumns):
 * a key that changes on a rebuild matches no saved row. Each owned column must be in the schema,
 * outside the key (only the row writer writes keys), not generated (MySQL
 * writes it, so no step owns it), and one the run can reset for its owner
 * (see resetValue).
 */
export function ownedColumnProblems(input: {
  readonly table: string;
  readonly owners: readonly ColumnOwner[];
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  /** The columns the comparison leaves out (unstableColumns). */
  readonly volatile: readonly string[];
}): string[] {
  const { table, owners, primaryKey } = input;
  const problems: string[] = [];
  if (!primaryKey.length) {
    problems.push(
      `${table} has column owners but no primary key: the run carries owned columns across a rebuild by the key`
    );
  }
  const volatileKey = primaryKey.filter((c) => input.volatile.includes(c));
  if (volatileKey.length) {
    problems.push(
      `${table} has column owners, but its primary key has volatile or exempt ${volatileKey.join(', ')}: the run carries owned columns across a rebuild by the key`
    );
  }
  const info = new Map(input.columns.map((c) => [c.name, c]));
  for (const owner of owners) {
    for (const column of owner.columns) {
      const found = info.get(column);
      if (!found) {
        problems.push(
          `column owner ${owner.step} owns ${table}.${column}, which the schema doesn't have`
        );
      } else if (primaryKey.includes(column)) {
        problems.push(
          `column owner ${owner.step} owns ${table}.${column}, part of the primary key: only the row writer writes keys`
        );
      } else if (generated(found)) {
        problems.push(
          `column owner ${owner.step} owns ${table}.${column}, a generated column: MySQL writes it`
        );
      } else if (resetValue(found) === null) {
        problems.push(
          `column owner ${owner.step} owns ${table}.${column}, a NOT NULL ${found.dataType} with no default: the run can't reset it for its owner`
        );
      }
    }
  }
  return problems;
}
