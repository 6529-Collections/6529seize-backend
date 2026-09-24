import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { Logger } from '@/logging';
import {
  runModerationCapture,
  moderationDatabaseCode
} from './moderation-capture-transaction';

const deadlock = () =>
  new SqlExecutionBudgetExceededError(
    'SQL_STATEMENT_FAILED',
    'WORK',
    'NOT_SENT',
    'ER_LOCK_DEADLOCK'
  );

describe('moderation capture recovery', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  );
  afterEach(() => jest.restoreAllMocks());

  it('retries acknowledged deadlock rollback with one shared deadline', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValue('saved');
    await expect(runModerationCapture(run)).resolves.toBe('saved');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual(run.mock.calls[1][0]);
    expect(run.mock.calls[0][0].executionBudget.lockWaitSeconds).toBe(1);
  });

  it('stops after three attempts', async () => {
    const failure = deadlock();
    const run = jest.fn().mockRejectedValue(failure);
    await expect(runModerationCapture(run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    new SqlExecutionBudgetExceededError(
      'SQL_STATEMENT_FAILED',
      'COMMIT',
      'UNKNOWN',
      'ER_LOCK_DEADLOCK'
    ),
    Object.assign(deadlock(), { connectionDestroyed: true }),
    Object.assign(new Error('private query'), { code: 'ER_LOCK_DEADLOCK' }),
    new SqlExecutionBudgetExceededError(
      'SQL_STATEMENT_FAILED',
      'WORK',
      'NOT_SENT',
      'ER_LOCK_WAIT_TIMEOUT'
    ),
    new SqlExecutionBudgetExceededError(
      'SQL_BUDGET_EXCEEDED',
      'WORK',
      'NOT_SENT'
    ),
    new SqlExecutionBudgetExceededError(
      'SQL_STATEMENT_FAILED',
      'WORK',
      'NOT_SENT',
      'ER_PARSE_ERROR'
    )
  ])('does not replay without proven safe rollback: %s', async (failure) => {
    const run = jest.fn().mockRejectedValue(failure);
    await expect(runModerationCapture(run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not expose arbitrary driver fields or messages', async () => {
    const failure = Object.assign(new Error('secret SQL'), {
      code: 'ER_PRIVATE_CATEGORY',
      sql: 'secret SQL',
      sqlMessage: 'private evidence'
    });
    expect(moderationDatabaseCode(failure)).toBe('UNKNOWN');
    await expect(
      runModerationCapture(jest.fn().mockRejectedValue(failure))
    ).rejects.toBe(failure);
    const logged = JSON.stringify(
      jest.mocked(Logger.prototype.warn).mock.calls
    );
    expect(logged).not.toMatch(/secret|private evidence|ER_PRIVATE_CATEGORY/);
  });
});
