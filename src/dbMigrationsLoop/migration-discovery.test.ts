import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type MigrationCallback = (error?: Error | null) => void;
type MigrationRecord = { name: string };
type MigrationDriver = {
  allLoadedMigrations: (
    callback: (error: null, rows: MigrationRecord[]) => void
  ) => void;
  startMigration: () => Promise<void>;
  endMigration: () => Promise<void>;
  runSql: (sql: string) => Promise<void>;
  addMigrationRecord: (name: string, callback: MigrationCallback) => void;
};
type MigrationRunner = {
  up: (options: { count: number }, callback: MigrationCallback) => void;
};
type MigrationInternals = {
  linked: boolean;
  matching: string;
  parser: { filesRegEx: RegExp };
  migrationOptions: Record<string, unknown>;
};

const Migrator = require('db-migrate/lib/migrator') as new (
  driver: MigrationDriver,
  directory: string,
  empty: boolean,
  internals: MigrationInternals
) => MigrationRunner;

const firstRetainedMigration = '20260101000000-first-retained';
const laterRetainedMigration = '20260301000000-later-retained';
const retiredMigration = '20260201000000-retired-component';

describe('dbMigrationsLoop migration discovery after retiring migration files', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), '6529-migration-discovery-'));
    for (const name of [firstRetainedMigration, laterRetainedMigration]) {
      writeFileSync(
        path.join(directory, `${name}.js`),
        `exports.up = function(db) { return db.runSql(${JSON.stringify(name)}); };\n`
      );
    }
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function runMigrations(completedNames: string[]) {
    const records = completedNames.map((name) => ({ name: `/${name}` }));
    const runSql = jest.fn(async (_sql: string) => undefined);
    const addMigrationRecord = jest.fn(
      (name: string, callback: MigrationCallback) => {
        records.push({ name });
        callback(null);
      }
    );
    const migrator = new Migrator(
      {
        allLoadedMigrations: (callback) => callback(null, records),
        startMigration: async () => undefined,
        endMigration: async () => undefined,
        runSql,
        addMigrationRecord
      },
      directory,
      false,
      {
        linked: true,
        matching: '',
        parser: { filesRegEx: /\.js$/ },
        migrationOptions: {}
      }
    );

    await new Promise<void>((resolve, reject) => {
      migrator.up({ count: Number.MAX_VALUE }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    return { runSql, addMigrationRecord, records };
  }

  it('runs retained migrations in order for an empty ledger', async () => {
    const { runSql, records } = await runMigrations([]);

    expect(runSql.mock.calls).toEqual([
      [firstRetainedMigration],
      [laterRetainedMigration]
    ]);
    expect(records).toEqual([
      { name: `/${firstRetainedMigration}` },
      { name: `/${laterRetainedMigration}` }
    ]);
  });

  it('keeps a retired ledger entry and applies only the pending retained migration', async () => {
    const { runSql, records } = await runMigrations([
      firstRetainedMigration,
      retiredMigration
    ]);

    expect(runSql.mock.calls).toEqual([[laterRetainedMigration]]);
    expect(records).toEqual([
      { name: `/${firstRetainedMigration}` },
      { name: `/${retiredMigration}` },
      { name: `/${laterRetainedMigration}` }
    ]);
  });

  it('does not reload absent files when every retained migration has run', async () => {
    const { runSql, addMigrationRecord } = await runMigrations([
      firstRetainedMigration,
      retiredMigration,
      laterRetainedMigration
    ]);

    expect(runSql).not.toHaveBeenCalled();
    expect(addMigrationRecord).not.toHaveBeenCalled();
  });
});
