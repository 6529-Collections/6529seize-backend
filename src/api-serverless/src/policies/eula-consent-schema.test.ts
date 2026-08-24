import path from 'node:path';
import { EULAConsent } from '@/entities/IEULAPolicy';
import { getMetadataArgsStorage } from 'typeorm';

const MIGRATION_FILE = 'migrations/20260824093509-add-eula-consent-version.js';

describe('EULA consent schema compatibility', () => {
  it('keeps legacy records representable as stale nullable versions', () => {
    const versionColumn = getMetadataArgsStorage().columns.find(
      (metadata) =>
        metadata.target === EULAConsent &&
        metadata.propertyName === 'eula_version'
    );

    expect(versionColumn?.options).toEqual(
      expect.objectContaining({
        type: 'varchar',
        length: 32,
        nullable: true,
        default: null
      })
    );
  });

  it('adds a nullable online column without rewriting legacy consent', async () => {
    const migration = require(path.resolve(process.cwd(), MIGRATION_FILE)) as {
      setup: (
        options: {
          dbmigrate: { dataType: object };
          Promise: PromiseConstructor;
        },
        seedLink: null
      ) => void;
      up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<void>;
      down: () => Promise<void>;
    };
    migration.setup({ dbmigrate: { dataType: {} }, Promise }, null);
    const statements: string[] = [];

    await migration.up({
      runSql: async (sql: string) => {
        statements.push(sql);
        return [];
      }
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ADD COLUMN eula_version varchar(32) NULL');
    expect(statements[0]).toContain('ALGORITHM=INPLACE');
    expect(statements[0]).toContain('LOCK=NONE');
    expect(statements[0]).not.toMatch(/UPDATE\s+eula_consent/i);
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
