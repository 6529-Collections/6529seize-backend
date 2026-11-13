import { SqlExecutor } from '@/sql-executor';

// Projection mappings are mechanically frozen from f3c959853, including the
// original ownership exceptions. No retired installer/runtime module is loaded.
// Column/collation discovery below reproduces that installer's exact assembly
// against the retained physical schema, before the separate absence proof.
const frozen = require('./origin-main-native-get-projections.json') as {
  revision: string;
  source_sha256: string;
  native_primary: string;
  wave_fields: Record<string, string>;
  drop_type: string;
  definitions: Record<
    string,
    { from: string; fields: Record<string, string>; ownership: string }
  >;
};
export const FROZEN_NATIVE_GET_TABLES = [
  'waves',
  'drops',
  ...Object.keys(frozen.definitions)
];
export function frozenNativeGetView(table: string): string {
  if (!FROZEN_NATIVE_GET_TABLES.includes(table))
    throw new Error('Unknown frozen compatibility table');
  return `contract_f3_get_${table}`;
}
export async function installFrozenNativeGetProjections(
  db: SqlExecutor
): Promise<void> {
  for (const table of FROZEN_NATIVE_GET_TABLES) {
    const metadata = await db.execute<{
      COLUMN_NAME: string;
      CHARACTER_SET_NAME: string | null;
      COLLATION_NAME: string | null;
    }>(
      'select COLUMN_NAME,CHARACTER_SET_NAME,COLLATION_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table order by ORDINAL_POSITION',
      { table }
    );
    if (!metadata.length)
      throw new Error(`Missing frozen source schema: ${table}`);
    const columns = metadata.map((row) => row.COLUMN_NAME);
    let select: string;
    if (table === 'waves') {
      select = `select ${columns.map((column) => `${frozen.wave_fields[column] ? `case when ${frozen.native_primary} then ${frozen.wave_fields[column]} else w.\`${column}\` end` : `w.\`${column}\``} as \`${column}\``).join(',')} from waves w left join competitions c on c.legacy_wave_id=w.id`;
    } else if (table === 'drops') {
      select = `select ${columns.map((column) => `${column === 'drop_type' ? frozen.drop_type : `d.\`${column}\``} as \`${column}\``).join(',')} from drops d left join competitions c on c.legacy_wave_id=d.wave_id and ${frozen.native_primary} left join competition_entries e on e.competition_id=c.id and e.drop_id=d.id`;
    } else {
      const native = frozen.definitions[table];
      if (columns.some((column) => !native.fields[column]))
        throw new Error(`Frozen compatibility schema drift: ${table}`);
      const nativeColumns = metadata
        .map((row) => {
          const field = native.fields[row.COLUMN_NAME];
          const value = row.CHARACTER_SET_NAME
            ? `convert(${field} using ${row.CHARACTER_SET_NAME}) collate ${row.COLLATION_NAME}`
            : field;
          return `${value} as \`${row.COLUMN_NAME}\``;
        })
        .join(',');
      select = `select ${columns.map((column) => `s.\`${column}\``).join(',')} from ${table} s where not exists (select 1 from competitions c where c.legacy_wave_id=s.wave_id and ${frozen.native_primary} ${native.ownership}) union all select ${nativeColumns} from ${native.from}`;
    }
    await db.execute(
      `create or replace sql security invoker view \`${frozenNativeGetView(table)}\` as ${select}`
    );
  }
}
