import 'reflect-metadata';
import {
  PROFILES_ACTIVITY_LOGS_TABLE,
  TDH_NFT_TABLE,
  USER_GROUPS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import { sqlExecutor } from '@/sql-executor';
import { DB_TEXT_COLLATION } from './db-collation';

/**
 * Columns that SQL compares across tables, views and inlined or JSON_TABLE
 * values. A collation that differs from production's turns those comparisons
 * into conversions (no index use) or "Illegal mix of collations" errors.
 */
const COMPARED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  [WAVES_TABLE, 'id'],
  [WAVES_TABLE, 'visibility_group_id'],
  [WAVES_TABLE, 'parent_wave_id'],
  [USER_GROUPS_TABLE, 'id'],
  [TDH_NFT_TABLE, 'contract'],
  [TDH_NFT_TABLE, 'consolidation_key'],
  [PROFILES_ACTIVITY_LOGS_TABLE, 'target_id'],
  [PROFILES_ACTIVITY_LOGS_TABLE, 'additional_data_2'],
  [legacyGetView(WAVES_TABLE), 'visibility_group_id'],
  [legacyGetView(WAVES_TABLE), 'participation_group_id'],
  [legacyGetView(WAVES_TABLE), 'voting_group_id'],
  [legacyGetView(WAVES_TABLE), 'voting_credit_creditor'],
  [legacyGetView(WAVE_VOTING_CREDIT_NFTS_TABLE), 'contract']
];

describe('database text collation', () => {
  it('creates the test schema with the production default collation', async () => {
    const schema = await sqlExecutor.oneOrNull<{ collation: string }>(
      `select default_collation_name as collation
       from information_schema.schemata
       where schema_name = database()`
    );
    expect(schema?.collation).toBe(DB_TEXT_COLLATION);
  });

  it('keeps every compared text column and view column on the production collation', async () => {
    const params: Record<string, string> = {};
    const matches = COMPARED_COLUMNS.map(([table, column], i) => {
      params[`table${i}`] = table;
      params[`column${i}`] = column;
      return `(table_name = :table${i} and column_name = :column${i})`;
    });
    const rows = await sqlExecutor.execute<{
      table_name: string;
      column_name: string;
      collation_name: string | null;
    }>(
      `select table_name as table_name, column_name as column_name,
              collation_name as collation_name
       from information_schema.columns
       where table_schema = database() and (${matches.join(' or ')})`,
      params
    );
    const actual = rows.reduce<Record<string, string | null>>((acc, row) => {
      acc[`${row.table_name}.${row.column_name}`] = row.collation_name;
      return acc;
    }, {});
    const expected = COMPARED_COLUMNS.reduce<Record<string, string>>(
      (acc, [table, column]) => {
        acc[`${table}.${column}`] = DB_TEXT_COLLATION;
        return acc;
      },
      {}
    );
    expect(actual).toEqual(expected);
  });
});
