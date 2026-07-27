import path from 'node:path';

describe('Release Bus v2 manifest status width migration', () => {
  it('widens online before precisely repairing candidate-evidence manifests', async () => {
    const migration = require(
      path.resolve(
        process.cwd(),
        'migrations/20260727203000-widen-release-bus-v2-manifest-status.js'
      )
    ) as {
      up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<void>;
      down: () => Promise<void>;
    };
    const statements: string[] = [];
    const log = jest.spyOn(console, 'info').mockImplementation();
    await migration.up({
      runSql: async (sql: string) => {
        statements.push(sql);
        return sql.startsWith('UPDATE') ? { affectedRows: 1 } : [];
      }
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(
      'MODIFY COLUMN status varchar(48) NOT NULL'
    );
    expect(statements[0]).toContain('ALGORITHM=INPLACE');
    expect(statements[0]).toContain('LOCK=NONE');
    expect(statements[1]).toContain(
      "SET status = 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'"
    );
    expect(statements[1]).toContain(
      "WHERE status = 'PRODUCTION_CANDIDATE_EVIDENCE_QU'"
    );
    expect(statements[1]).toContain(
      "'production-candidate-evidence-qualification'"
    );
    expect(statements[1]).toContain("'CANDIDATE_STAGING_EVIDENCE_V1'");
    expect(log).toHaveBeenCalledWith(
      '[release-bus-v2] repaired 1 truncated candidate-evidence qualification manifest status row(s)'
    );
    log.mockRestore();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
