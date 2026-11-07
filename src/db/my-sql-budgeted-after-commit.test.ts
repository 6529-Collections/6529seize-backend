import type { PoolConnection } from 'mysql';
import { afterCommit } from './after-commit';
import { execBudgetedNativeTransactionally } from './my-sql.helpers';
import { executeBudgetedSqlTransaction } from '@/db/sql-execution-budget';

jest.mock('@/db/sql-execution-budget', () => ({
  ...jest.requireActual('@/db/sql-execution-budget'),
  executeBudgetedSqlTransaction: jest.fn()
}));

const executeMock = jest.mocked(executeBudgetedSqlTransaction);
const budget = {} as never;

/** Simulates the budget executor: run the work, then COMMIT or fail. */
function executorThat(outcome: 'commit' | 'rollback', events: string[]) {
  executeMock.mockImplementation(async (acquire, _budget, executable) => {
    const lease = await acquire();
    const result = await executable(lease.handle);
    if (outcome === 'rollback') {
      events.push('ROLLBACK');
      throw new Error('commit failed');
    }
    events.push('COMMIT');
    return result;
  });
}

describe('execBudgetedNativeTransactionally after-commit callbacks', () => {
  const connection = { release: jest.fn() } as unknown as PoolConnection;

  it('defers callbacks until the budgeted COMMIT is acknowledged', async () => {
    const events: string[] = [];
    executorThat('commit', events);

    await expect(
      execBudgetedNativeTransactionally(
        async (bound) => {
          await afterCommit(bound, () => events.push('EFFECT'), 'k');
          await afterCommit(bound, () => events.push('DUPLICATE'), 'k');
          events.push('WORK');
          return 'done';
        },
        async () => connection,
        budget
      )
    ).resolves.toBe('done');

    expect(events).toEqual(['WORK', 'COMMIT', 'EFFECT']);
  });

  it('drops callbacks when the budgeted transaction fails', async () => {
    const events: string[] = [];
    executorThat('rollback', events);
    const effect = jest.fn();

    await expect(
      execBudgetedNativeTransactionally(
        async (bound) => {
          await afterCommit(bound, effect);
        },
        async () => connection,
        budget
      )
    ).rejects.toThrow('commit failed');

    expect(effect).not.toHaveBeenCalled();
    // The pooled connection is no longer in a tracked transaction.
    await afterCommit({ connection }, effect);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
