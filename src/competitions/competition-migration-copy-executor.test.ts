import { MigrationCopySqlExecutor } from './competition-migration-copy-executor';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { SqlExecutor } from '@/sql-executor';

describe('migration copy diagnostics', () => {
  it('preserves transaction context and adds no SQL or parameters to a budget failure', async () => {
    const failure = new SqlExecutionBudgetExceededError(
      'SQL_BUDGET_EXCEEDED',
      'WORK',
      'NOT_SENT'
    );
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ value: 7 }])
      .mockRejectedValueOnce(failure);
    const delegate = { execute } as unknown as SqlExecutor;
    const db = new MigrationCopySqlExecutor(delegate);
    const options = { wrappedConnection: { connection: {} } };
    await expect(
      db.oneOrNull(
        'select :privateValue',
        { privateValue: 'private-profile' },
        options
      )
    ).resolves.toEqual({ value: 7 });
    await expect(
      db.execute(
        "insert into competition_votes values ('private-profile')",
        { secret: 'private-value' },
        options
      )
    ).rejects.toBe(failure);
    expect(execute.mock.calls[0][2]).toBe(options);
    expect(failure).toMatchObject({
      migrationStatementNumber: 2,
      migrationStatementFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      commitOutcome: 'NOT_SENT'
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /private-profile|private-value|insert into|select :/
    );
  });

  it('passes through unrelated failures without reclassifying or retrying them', async () => {
    const failure = new Error('source unavailable');
    const execute = jest.fn().mockRejectedValue(failure);
    const db = new MigrationCopySqlExecutor({
      execute
    } as unknown as SqlExecutor);
    await expect(db.execute('select 1')).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveProperty('migrationStatementFingerprint');
  });
  it.each(['oneOrNull', 'bulkUpsert'] as const)(
    'diagnoses inherited %s failures through execute without leaking values',
    async (operation) => {
      const failure = new SqlExecutionBudgetExceededError(
        'SQL_BUDGET_EXCEEDED',
        'WORK',
        'NOT_SENT'
      );
      const execute = jest.fn().mockRejectedValue(failure);
      const db = new MigrationCopySqlExecutor({
        execute
      } as unknown as SqlExecutor);
      const result =
        operation === 'oneOrNull'
          ? db.oneOrNull('select :privateValue', {
              privateValue: 'secret-profile'
            })
          : db.bulkUpsert(
              'competition_votes',
              [{ id: 'secret-profile' }],
              ['id'],
              ['id']
            );
      await expect(result).rejects.toBe(failure);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(failure).toMatchObject({
        migrationStatementNumber: 1,
        migrationStatementFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
      expect(JSON.stringify(failure)).not.toMatch(
        /secret-profile|insert into|select :/
      );
    }
  );

  it('does not mask an immutable budget failure with a diagnostic assignment error', async () => {
    const failure = Object.freeze(
      new SqlExecutionBudgetExceededError(
        'SQL_BUDGET_EXCEEDED',
        'WORK',
        'NOT_SENT'
      )
    );
    const db = new MigrationCopySqlExecutor({
      execute: jest.fn().mockRejectedValue(failure)
    } as unknown as SqlExecutor);
    await expect(db.execute('select 1')).rejects.toBe(failure);
  });
});
