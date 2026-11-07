import type { PoolConnection } from 'mysql';

type Helpers = typeof import('./my-sql.helpers');
type AfterCommit = typeof import('./after-commit');

const executeMock = jest.fn();
const budget = {} as never;

/**
 * Loads the helpers in their own module registry with the budget executor
 * replaced, so setup files that already imported the real executor do not
 * bypass the mock.
 */
function load(): { helpers: Helpers; afterCommit: AfterCommit['afterCommit'] } {
  let loaded: { helpers: Helpers; afterCommit: AfterCommit['afterCommit'] };
  jest.isolateModules(() => {
    jest.doMock('@/db/sql-execution-budget', () => ({
      ...jest.requireActual('@/db/sql-execution-budget'),
      executeBudgetedSqlTransaction: executeMock
    }));
    loaded = {
      helpers: require('./my-sql.helpers'),
      afterCommit: require('./after-commit').afterCommit
    };
  });
  return loaded!;
}

/** Simulates the budget executor: run the work, then COMMIT or fail. */
function executorThat(outcome: 'commit' | 'rollback', events: string[]) {
  executeMock.mockImplementation(
    async (
      acquire: () => Promise<{ handle: object }>,
      _budget: unknown,
      executable: (handle: object) => Promise<unknown>
    ) => {
      const lease = await acquire();
      const result = await executable(lease.handle);
      if (outcome === 'rollback') {
        events.push('ROLLBACK');
        throw new Error('commit failed');
      }
      events.push('COMMIT');
      return result;
    }
  );
}

describe('execBudgetedNativeTransactionally after-commit callbacks', () => {
  const connection = { release: jest.fn() } as unknown as PoolConnection;

  afterEach(() => {
    executeMock.mockReset();
  });

  it('defers callbacks until the budgeted COMMIT is acknowledged', async () => {
    const { helpers, afterCommit } = load();
    const events: string[] = [];
    executorThat('commit', events);

    await expect(
      helpers.execBudgetedNativeTransactionally(
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

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['WORK', 'COMMIT', 'EFFECT']);
  });

  it('drops callbacks when the budgeted transaction fails', async () => {
    const { helpers, afterCommit } = load();
    const events: string[] = [];
    executorThat('rollback', events);
    const effect = jest.fn();

    await expect(
      helpers.execBudgetedNativeTransactionally(
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
