import { RebuildStep } from '@/rebuild/manifest.types';
import { columnWritesOf, writtenTables } from '@/rebuild/step-writes';

/** MySQL 1143: a column-level privilege missing. */
const COLUMN_DENIED =
  /([A-Z]+(?:, [A-Z]+)*) command denied to user '[^']*'@'[^']*' for column '([^']+)' in table '([^']+)'/g;
/** MySQL 1142: a table-level privilege missing. */
const TABLE_DENIED =
  /([A-Z]+(?:, [A-Z]+)*) command denied to user '[^']*'@'[^']*' for table '([^']+)'/g;

/**
 * What MySQL refused a step, from its log (errors 1142 and 1143), with the
 * step's own declarations as the reason: a column another step owns, a
 * table the step only owns columns of or only reads, or one its reads and
 * writes don't name.
 */
export function refusalsIn(step: RebuildStep, log: string): string[] {
  const found = new Set<string>();
  const ownedOf = (table: string) =>
    columnWritesOf(step)
      .filter((write) => write.table === table)
      .flatMap((write) => write.columns);
  for (const match of Array.from(log.matchAll(COLUMN_DENIED))) {
    const [, command, column, table] = match;
    const owned = ownedOf(table);
    found.add(
      `${step.id} may not ${command} column ${column} of ${table}: ${
        owned.length
          ? `it owns only ${owned.join(', ')} there`
          : 'a column owner owns it'
      }`
    );
  }
  for (const match of Array.from(log.matchAll(TABLE_DENIED))) {
    const [, command, table] = match;
    // A step may read the tables in its reads and its writes.
    const why = ownedOf(table).length
      ? 'it owns only columns there'
      : writtenTables(step).includes(table)
        ? 'its grants on the table refuse it'
        : (step.reads ?? []).includes(table)
          ? 'it only reads the table'
          : /SELECT/.test(command)
            ? "the table isn't in its reads or writes"
            : "the table isn't in its writes";
    found.add(`${step.id} may not ${command} ${table}: ${why}`);
  }
  return Array.from(found);
}
