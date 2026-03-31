import 'reflect-metadata';
import { sqlExecutor } from '../../sql-executor';
import { collections } from '../../collections';
import * as mysql from 'mysql';

export interface Seed {
  table: string;
  rows: Record<string, any>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeSeedValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    return JSON.stringify(value);
  }

  return value;
}

function buildInsertSql(table: string, row: Record<string, any>): string {
  const columns = Object.keys(row);
  const escapedColumns = columns
    .map((column) => mysql.escapeId(column))
    .join(', ');
  const escapedValues = columns
    .map((column) => mysql.escape(normalizeSeedValue(row[column])))
    .join(', ');

  return `INSERT INTO ${mysql.escapeId(table)} (${escapedColumns}) VALUES (${escapedValues})`;
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
            await tx.connection.query(buildInsertSql(table, row));
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
