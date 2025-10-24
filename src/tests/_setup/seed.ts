import 'reflect-metadata';
import { sqlExecutor } from '../../sql-executor';
import { collections } from '../../collections';

export interface Seed {
  table: string;
  rows: Record<string, any>[];
}

export function describeWithSeed(
  title: string,
  seeds: Seed | Seed[],
  body: () => void
) {
  const seedArr = Array.isArray(seeds) ? seeds : [seeds];

  describe(title, () => {
    beforeEach(async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(async (tx) => {
        for (const { table, rows } of seedArr) {
          for (const row of rows) {
            await tx.connection.query(`INSERT INTO ${table} SET ?`, row);
          }
        }
      });
    });

    body();

    afterEach(async () => {
      const tables = collections.distinct(seedArr.map(({ table }) => table));
      for (const table of tables) {
        await sqlExecutor.execute(`DELETE FROM ${table}`);
      }
    });
  });
}
