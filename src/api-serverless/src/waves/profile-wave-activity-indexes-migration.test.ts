import path from 'node:path';

type ProfileWaveActivityIndexesMigration = {
  up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<unknown>;
  down: () => Promise<unknown>;
};

function loadMigration(): ProfileWaveActivityIndexesMigration {
  return require(
    path.resolve(
      process.cwd(),
      'migrations/20260827104142-add-profile-wave-activity-indexes.js'
    )
  ) as ProfileWaveActivityIndexesMigration;
}

describe('profile wave activity indexes migration', () => {
  it('adds both composite indexes online and has a non-destructive down', async () => {
    const migration = loadMigration();
    const statements: string[] = [];

    await migration.up({
      runSql: async (sql: string) => {
        statements.push(sql);
        return [];
      }
    });

    expect(statements).toEqual([
      'ALTER TABLE wave_dropper_metrics ADD INDEX idx_wdm_dropper_latest_wave (dropper_id, latest_drop_timestamp, wave_id), ALGORITHM=INPLACE, LOCK=NONE',
      'ALTER TABLE waves ADD INDEX idx_wave_created_dm_serial_id (created_by, is_direct_message, serial_no, id), ALGORITHM=INPLACE, LOCK=NONE'
    ]);
    for (const statement of statements) {
      expect(statement).toContain('ALGORITHM=INPLACE');
      expect(statement).toContain('LOCK=NONE');
    }
    await expect(migration.down()).resolves.toBeUndefined();
  });

  it('continues only for duplicate index names', async () => {
    const migration = loadMigration();
    const runSql = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ER_DUP_KEYNAME' })
      .mockResolvedValueOnce([]);

    await expect(migration.up({ runSql })).resolves.toEqual([]);
    expect(runSql).toHaveBeenCalledTimes(2);

    const unexpectedError = Object.assign(new Error('migration failed'), {
      code: 'ER_LOCK_WAIT_TIMEOUT'
    });
    await expect(
      migration.up({ runSql: jest.fn().mockRejectedValue(unexpectedError) })
    ).rejects.toBe(unexpectedError);
  });
});
