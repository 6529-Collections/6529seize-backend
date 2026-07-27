import path from 'node:path';

describe('Release Bus v2 candidate production evidence migration', () => {
  it('adds only backward-compatible online ledger columns', async () => {
    const migration = require(
      path.resolve(
        process.cwd(),
        'migrations/20260727093000-add-release-bus-v2-candidate-production-evidence.js'
      )
    ) as {
      up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<void>;
      down: () => Promise<void>;
    };
    const statements: string[] = [];
    await migration.up({
      runSql: async (sql: string) => {
        statements.push(sql);
        return [];
      }
    });

    expect(statements).toHaveLength(4);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('production_selection_id varchar(36) NULL'),
        expect.stringContaining('qualification_policy varchar(64) NULL'),
        expect.stringContaining('qualification_evidence_json json NULL')
      ])
    );
    for (const statement of statements) {
      expect(statement).toContain('ALGORITHM=INPLACE');
      expect(statement).toContain('LOCK=NONE');
    }
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
