import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { fetchTDHGlobalHistory } from '@/db-api';
import {
  GlobalTDHHistory,
  LatestGlobalTDHHistory,
  LatestTDHHistory,
  RecentTDHHistory,
  TDHHistory
} from '@/entities/ITDHHistory';
import { widenGlobalTdhHistoryBeforeSchemaSync } from './global-tdh-history-schema';

const globalTables = [GlobalTDHHistory, LatestGlobalTDHHistory];
const consolidationTables = [TDHHistory, LatestTDHHistory, RecentTDHHistory];
const sumColumns = [
  'total',
  'memes',
  'gradients',
  'created',
  'destroyed',
  'net'
].flatMap((prefix) =>
  ['tdh', 'boosted_tdh', 'tdh__raw'].map((suffix) => `${prefix}_${suffix}`)
);

describe('Global TDH history widening', () => {
  it('preserves both tables and returns large totals as JSON numbers after a retry', async () => {
    const source = await new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: [...globalTables, ...consolidationTables],
      timezone: 'Z'
    }).initialize();

    const existingRow = {
      date: new Date('2026-11-10'),
      block: 26380783,
      ...Object.fromEntries(sumColumns.map((column) => [column, 17])),
      net_tdh: -17,
      total_boosted_tdh: 2_144_553_718,
      memes_boosted_tdh: 2_132_284_321,
      memes_balance: 123,
      gradients_balance: 10,
      nextgen_balance: 0,
      created_balance: 3,
      destroyed_balance: 6,
      net_balance: -3,
      total_consolidated_wallets: 25,
      total_wallets: 50
    };
    const largeTotals = {
      total_boosted_tdh: 2_153_576_000,
      memes_boosted_tdh: 2_147_483_648,
      net_boosted_tdh: -2_147_483_649
    };

    try {
      await source.synchronize();
      for (const entity of globalTables) {
        const table = source.getMetadata(entity).tableName;
        await source.createQueryBuilder().delete().from(entity).execute();
        await source.query(
          `ALTER TABLE ${table} ${sumColumns
            .map((column) => `MODIFY COLUMN ${column} INT NOT NULL`)
            .join(', ')}`
        );
        await source.getRepository(entity).insert(existingRow);
      }
      await widenGlobalTdhHistoryBeforeSchemaSync(source);
      for (const entity of globalTables) {
        const row = await source.getRepository(entity).findOneByOrFail({
          date: existingRow.date,
          block: existingRow.block
        });
        expect(Number(row.total_boosted_tdh)).toBe(
          existingRow.total_boosted_tdh
        );
        expect(Number(row.memes_boosted_tdh)).toBe(
          existingRow.memes_boosted_tdh
        );
      }

      await source
        .getRepository(GlobalTDHHistory)
        .update(
          { date: existingRow.date, block: existingRow.block },
          largeTotals
        );

      await widenGlobalTdhHistoryBeforeSchemaSync(source);
      expect(
        (await source.driver.createSchemaBuilder().log()).upQueries
      ).toEqual([]);

      for (const entity of globalTables) {
        const table = source.getMetadata(entity).tableName;
        const columns: { name: string; type: string }[] = await source.query(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
           FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ?`,
          [table]
        );
        expect(
          columns
            .filter((column) => column.type === 'bigint')
            .map((column) => column.name)
        ).toEqual(expect.arrayContaining(sumColumns));
        expect(
          columns.filter((column) => column.type === 'bigint')
        ).toHaveLength(sumColumns.length);
      }

      for (const entity of consolidationTables) {
        const columns: { name: string; type: string }[] = await source.query(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
           FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND COLUMN_NAME = 'net_tdh'`,
          [source.getMetadata(entity).tableName]
        );
        expect(columns).toEqual([{ name: 'net_tdh', type: 'int' }]);
      }

      const result = await fetchTDHGlobalHistory(5, 1);
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        count: 1,
        page: 1,
        next: null,
        data: [{ ...largeTotals, block: existingRow.block, net_tdh: -17 }]
      });
    } finally {
      for (const entity of globalTables) {
        await source.createQueryBuilder().delete().from(entity).execute();
      }
      await source.destroy();
    }
  });
});
