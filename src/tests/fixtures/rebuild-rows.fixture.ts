import { sqlExecutor } from '@/sql-executor';

/**
 * Rows for database tests that care about a few columns of a wide table:
 * every other required column gets a made-up value of its type (an enum's
 * first value, {} for JSON, 0 for a flag, a counter for a number, a
 * unique text otherwise). Generated, nullable and defaulted columns are
 * left to MySQL.
 */
type Column = {
  name: string;
  type: string;
  nullable: boolean;
  defaulted: boolean;
  generated: boolean;
  enumValues: string[];
};

const columnsOf = new Map<string, Column[]>();
let serial = 0;

async function columns(table: string): Promise<Column[]> {
  const known = columnsOf.get(table);
  if (known) return known;
  const rows = await sqlExecutor.execute<Record<string, unknown>>(
    `select column_name as name, data_type as type, is_nullable as nullable,
            column_default as dflt, extra as extra, column_type as ctype
       from information_schema.columns
      where table_schema = database() and table_name = :table`,
    { table }
  );
  const result = rows.map((row) => {
    const extra = String(row.extra ?? '');
    return {
      name: String(row.name),
      type: String(row.type).toLowerCase(),
      nullable: row.nullable === 'YES',
      defaulted: row.dflt !== null || /auto_increment/i.test(extra),
      generated: /generated/i.test(extra),
      enumValues: (String(row.ctype).match(/'([^']*)'/g) ?? []).map((v) =>
        v.slice(1, -1)
      )
    };
  });
  if (!result.length) throw new Error(`no table ${table}`);
  columnsOf.set(table, result);
  return result;
}

/** A value for a required column the test doesn't care about. */
function filler(column: Column): unknown {
  serial++;
  if (column.enumValues.length) return column.enumValues[0];
  if (column.type === 'json') return '{}';
  if (/^(tinyint|bit|bool)/.test(column.type)) return 0;
  if (/^smallint/.test(column.type)) return serial % 30000;
  if (/int|decimal|double|float/.test(column.type)) return serial;
  if (/date|time/.test(column.type)) return '2026-01-01 00:00:00';
  return `filler-${serial}`;
}

/** Inserts a row with the given values, filling every other required column. */
export async function insertRow(
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const row: Record<string, unknown> = { ...values };
  for (const column of await columns(table)) {
    if (column.name in row || column.generated) continue;
    if (column.nullable || column.defaulted) continue;
    row[column.name] = filler(column);
  }
  const names = Object.keys(row);
  await sqlExecutor.execute(
    `insert into ${table} (${names.map((n) => `\`${n}\``).join(', ')})
     values (${names.map((n) => `:${n}`).join(', ')})`,
    row
  );
}
