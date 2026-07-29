import path from 'node:path';

type MigrationDb = {
  runSql: (sql: string) => Promise<unknown>;
  all: (
    sql: string,
    callback: (error: Error | null, rows?: unknown[]) => void
  ) => void;
};

function loadMigration() {
  return require(
    path.resolve(
      process.cwd(),
      'migrations/20260727211500-repair-release-bus-v2-manifest-status-ledger.js'
    )
  ) as {
    up: (db: MigrationDb) => Promise<void>;
    down: () => Promise<void>;
  };
}

describe('Release Bus v2 manifest status ledger repair migration', () => {
  it('restores every lifecycle class and verifies no invalid row remains', async () => {
    const migration = loadMigration();
    const statements: string[] = [];
    const log = jest.spyOn(console, 'info').mockImplementation();
    await migration.up({
      runSql: async (sql: string) => {
        statements.push(sql);
        return { affectedRows: 1 };
      },
      all: (sql, callback) => {
        statements.push(sql);
        callback(
          null,
          sql.includes('AS unclassified')
            ? [{ unclassified: 0 }]
            : [{ remaining: 0 }]
        );
      }
    });

    expect(statements).toHaveLength(7);
    expect(statements[0]).toContain('COUNT(*) AS unclassified');
    expect(statements[0]).toContain(
      "deployed_event.event_type = 'TRAIN_STAGING_DEPLOYED'"
    );
    expect(statements[1]).toContain(
      "status = 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'"
    );
    expect(statements[2]).toContain("status = 'PRODUCTION_DEPLOYED'");
    expect(statements[3]).toContain("manifest.status = 'FAILED'");
    expect(statements[3]).toContain('manifest.validated_at IS NULL');
    expect(statements[3]).toContain("'CUMULATIVE_STAGING_ROLLBACK_STARTED'");
    expect(statements[4]).toContain("status = 'STAGING_VALIDATED'");
    expect(statements[4]).toContain('AND NOT EXISTS');
    expect(statements[5]).toContain("manifest.status = 'STAGING_DEPLOYED'");
    expect(statements[5]).toContain(
      "event.event_type = 'TRAIN_STAGING_DEPLOYED'"
    );
    expect(statements[5]).toContain(
      'failure_event.train_id = manifest.train_id'
    );
    expect(statements[6]).toContain(
      "status = 'PRODUCTION_CANDIDATE_EVIDENCE_QU'"
    );
    expect(log).toHaveBeenLastCalledWith(
      '[release-bus-v2] manifest status ledger repair left 0 invalid row(s)'
    );
    log.mockRestore();
    await expect(migration.down()).resolves.toBeUndefined();
  });

  it('fails closed when any blank or truncated status is unclassified', async () => {
    const migration = loadMigration();
    const log = jest.spyOn(console, 'info').mockImplementation();

    await expect(
      migration.up({
        runSql: async (_sql: string) => {
          return { affectedRows: 0 };
        },
        all: (sql, callback) => {
          callback(
            null,
            sql.includes('AS unclassified')
              ? [{ unclassified: 0 }]
              : [{ remaining: 1 }]
          );
        }
      })
    ).rejects.toThrow(
      'Release Bus v2 manifest status repair left 1 unclassified row(s)'
    );
    log.mockRestore();
  });

  it('fails before mutation when preflight finds contradictory evidence', async () => {
    const migration = loadMigration();
    const statements: string[] = [];
    const log = jest.spyOn(console, 'info').mockImplementation();

    await expect(
      migration.up({
        runSql: async (sql: string) => {
          statements.push(sql);
          return { affectedRows: 0 };
        },
        all: (sql, callback) => {
          statements.push(sql);
          callback(null, [{ unclassified: 1 }]);
        }
      })
    ).rejects.toThrow(
      'Release Bus v2 manifest status repair found 1 unclassified row(s) before mutation'
    );
    expect(statements).toHaveLength(1);
    log.mockRestore();
  });
});
