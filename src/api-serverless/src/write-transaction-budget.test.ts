import {
  runWriteTransaction,
  withRequestDeadline,
  WriteBusyException,
  WriteOutcomeUnknownException
} from '@/api/write-transaction-budget';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';

function budgetError(
  code: ConstructorParameters<typeof SqlExecutionBudgetExceededError>[0],
  commitOutcome: ConstructorParameters<
    typeof SqlExecutionBudgetExceededError
  >[2],
  serverCode?: string
) {
  return new SqlExecutionBudgetExceededError(
    code,
    commitOutcome === 'NOT_SENT' ? 'WORK' : 'COMMIT',
    commitOutcome,
    serverCode
  );
}

const inRequest = <T>(work: () => Promise<T>) =>
  withRequestDeadline(30_000, work);

describe('runWriteTransaction', () => {
  it('answers WRITE_BUSY with Retry-After when the budget gave up before COMMIT', async () => {
    const error = await inRequest(() =>
      runWriteTransaction(() =>
        Promise.reject(budgetError('SQL_BUDGET_EXCEEDED', 'NOT_SENT'))
      )
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteBusyException);
    expect((error as WriteBusyException).retryAfterSeconds).toBe(2);
  });

  it('answers WRITE_BUSY when a lock wait gave up before COMMIT', async () => {
    await expect(
      inRequest(() =>
        runWriteTransaction(() =>
          Promise.reject(
            budgetError(
              'SQL_STATEMENT_FAILED',
              'NOT_SENT',
              'ER_LOCK_WAIT_TIMEOUT'
            )
          )
        )
      )
    ).rejects.toBeInstanceOf(WriteBusyException);
  });

  it('answers WRITE_OUTCOME_UNKNOWN without Retry-After when COMMIT may have happened', async () => {
    const error = await inRequest(() =>
      runWriteTransaction(() =>
        Promise.reject(budgetError('SQL_BUDGET_EXCEEDED', 'UNKNOWN'))
      )
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteOutcomeUnknownException);
    expect(error).not.toBeInstanceOf(WriteBusyException);
    expect(
      (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
    ).toBeUndefined();
    expect((error as WriteOutcomeUnknownException).code).toBe(
      'WRITE_OUTCOME_UNKNOWN'
    );
  });

  it('reruns once unbudgeted when statements overlapped on the budgeted connection', async () => {
    const calls: unknown[] = [];
    const result = await inRequest(() =>
      runWriteTransaction(async (options) => {
        calls.push(options);
        if (calls.length === 1)
          throw budgetError('SQL_CONCURRENT_STATEMENTS', 'NOT_SENT');
        return 'written';
      })
    );
    expect(result).toBe('written');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ executionBudget: expect.anything() });
    expect(calls[1]).toBeUndefined();
  });

  it('passes other errors through', async () => {
    const failure = new Error('validation');
    await expect(
      inRequest(() => runWriteTransaction(() => Promise.reject(failure)))
    ).rejects.toBe(failure);
  });
});
