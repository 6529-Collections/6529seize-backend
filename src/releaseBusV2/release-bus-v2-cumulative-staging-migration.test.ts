import path from 'node:path';

describe('Release Bus v2 cumulative staging migration', () => {
  it('adds an online current-live ledger and an idempotent singleton state', async () => {
    const migration = require(
      path.resolve(
        process.cwd(),
        'migrations/20260727100000-add-release-bus-v2-cumulative-staging.js'
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

    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "staging_live_state varchar(32) NOT NULL DEFAULT 'NOT_LIVE'"
        ),
        expect.stringContaining('staging_live_manifest_id varchar(36) NULL'),
        expect.stringContaining('staging_transition_request varchar(32) NULL'),
        expect.stringContaining('staging_policy varchar(64) NULL'),
        expect.stringContaining(
          "candidate_role varchar(32) NOT NULL DEFAULT 'NEW'"
        ),
        expect.stringContaining('CREATE TABLE release_bus_v2_staging_state'),
        expect.stringContaining("'current', 'UNINITIALIZED'")
      ])
    );
    for (const statement of statements.filter((sql) =>
      sql.startsWith('ALTER TABLE')
    )) {
      expect(statement).toContain('ALGORITHM=INPLACE');
      expect(statement).toContain('LOCK=NONE');
    }
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
