import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { PoolConnection } from 'mysql';
import {
  afterCommit,
  beforeCommit,
  closeAfterCommitScope,
  openAfterCommitScope,
  runBeforeCommitChecks
} from './after-commit';
import { execNativeTransactionally } from './my-sql.helpers';
import { SqlExecutionBudget } from './sql-execution-budget';
import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import {
  fakePoolConnection,
  settle
} from '@/tests/fixtures/freeze-at-commit.fixture';

describe('beforeCommit', () => {
  it('runs the check at once without a tracked transaction', () => {
    const check = jest.fn();

    beforeCommit(undefined, 'k', check);
    beforeCommit({ connection: undefined }, 'k', check);
    beforeCommit({ connection: {} }, 'k', check);

    expect(check).toHaveBeenCalledTimes(3);
  });

  it('throws at once without a tracked transaction when the check fails', () => {
    const failure = new IdentityFrozenException();
    expect(() =>
      beforeCommit({ connection: {} }, 'k', () => {
        throw failure;
      })
    ).toThrow(failure);
  });

  it('defers checks to runBeforeCommitChecks and runs them in order, once per key', () => {
    const handle = {};
    const order: string[] = [];
    openAfterCommitScope(handle);

    beforeCommit({ connection: handle }, 'a', () => order.push('a'));
    beforeCommit({ connection: handle }, 'b', () => order.push('b'));
    beforeCommit({ connection: handle }, 'a', () => order.push('a again'));
    expect(order).toEqual([]);

    runBeforeCommitChecks(handle);
    expect(order).toEqual(['a', 'b']);
    closeAfterCommitScope(handle);
  });

  it('throws the first failing check and runs none registered after it', () => {
    const handle = {};
    const failure = new IdentityFrozenException();
    const later = jest.fn();
    openAfterCommitScope(handle);
    beforeCommit({ connection: handle }, 'first', () => {
      throw failure;
    });
    beforeCommit({ connection: handle }, 'second', later);

    expect(() => runBeforeCommitChecks(handle)).toThrow(failure);
    expect(later).not.toHaveBeenCalled();
    closeAfterCommitScope(handle);
  });

  it('does nothing when nothing was registered', () => {
    const tracked = {};
    openAfterCommitScope(tracked);
    expect(() => runBeforeCommitChecks(tracked)).not.toThrow();
    closeAfterCommitScope(tracked);
    expect(() => runBeforeCommitChecks({})).not.toThrow();
  });

  it('forgets the checks when the scope closes or opens again', () => {
    const handle = {};
    const check = jest.fn();

    openAfterCommitScope(handle);
    beforeCommit({ connection: handle }, 'k', check);
    closeAfterCommitScope(handle);
    openAfterCommitScope(handle);
    runBeforeCommitChecks(handle);
    expect(check).not.toHaveBeenCalled();

    // A scope opened again without being closed starts empty too.
    beforeCommit({ connection: handle }, 'k', check);
    openAfterCommitScope(handle);
    runBeforeCommitChecks(handle);
    expect(check).not.toHaveBeenCalled();
    closeAfterCommitScope(handle);

    // Once closed, the connection is no longer in a transaction: a check runs
    // at once, and nothing is left to run at a later COMMIT.
    beforeCommit({ connection: handle }, 'k', check);
    expect(check).toHaveBeenCalledTimes(1);
    runBeforeCommitChecks(handle);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('execNativeTransactionally runs the checks right before COMMIT', () => {
  const isolation = [
    ['without options', undefined, []],
    [
      'with an isolation level',
      { isolationLevel: 'READ COMMITTED' as const },
      ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED']
    ]
  ] as const;

  it.each(isolation)(
    'sends exactly the statements it sent before when nothing is registered (%s)',
    async (_, options, setup) => {
      const { connection, statements } = fakePoolConnection();
      const query = jest.spyOn(connection, 'query');
      const commit = jest.spyOn(connection, 'commit');
      const begin = jest.spyOn(connection, 'beginTransaction');

      await expect(
        execNativeTransactionally(
          async () => {
            statements.push('WORK');
            return 'done';
          },
          connection,
          options
        )
      ).resolves.toBe('done');

      expect(statements).toEqual([
        ...setup,
        'BEGIN',
        'WORK',
        'COMMIT',
        'RELEASE'
      ]);
      expect(query).toHaveBeenCalledTimes(setup.length);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(1);
    }
  );

  it('sends no statement of its own for a check that passes', async () => {
    const { connection, statements } = fakePoolConnection();

    await execNativeTransactionally(async (bound) => {
      statements.push('WORK');
      beforeCommit(bound, 'k', () => {
        statements.push('CHECK');
      });
    }, connection);

    expect(statements).toEqual(['BEGIN', 'WORK', 'CHECK', 'COMMIT', 'RELEASE']);
  });

  it('runs a check registered early only after the last statement of the work', async () => {
    const { connection, statements } = fakePoolConnection();

    await execNativeTransactionally(async (bound) => {
      beforeCommit(bound, 'k', () => {
        statements.push('CHECK');
      });
      statements.push('LOCK');
      await new Promise((resolve) => setImmediate(resolve));
      statements.push('WRITE');
    }, connection);

    expect(statements).toEqual([
      'BEGIN',
      'LOCK',
      'WRITE',
      'CHECK',
      'COMMIT',
      'RELEASE'
    ]);
  });

  it.each(isolation)(
    'rolls the whole transaction back on a failing check, releases the connection and rethrows the freeze error (%s)',
    async (_, options, setup) => {
      const { connection, statements, release } = fakePoolConnection();
      const begin = jest.spyOn(connection, 'beginTransaction');
      const commit = jest.spyOn(connection, 'commit');
      const rollback = jest.spyOn(connection, 'rollback');
      const failure = new IdentityFrozenException();
      const effect = jest.fn();

      const { error } = await settle(
        execNativeTransactionally(
          async (bound) => {
            beforeCommit(bound, 'k', () => {
              throw failure;
            });
            await afterCommit(bound, effect);
            statements.push('WRITE');
            return 'written';
          },
          connection,
          options
        )
      );

      expect(error).toBe(failure);
      expect((error as IdentityFrozenException).getStatusCode()).toBe(423);
      expect(statements).toEqual([
        ...setup,
        'BEGIN',
        'WRITE',
        'ROLLBACK',
        'RELEASE'
      ]);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(rollback.mock.invocationCallOrder[0]).toBeLessThan(
        release.mock.invocationCallOrder[0]
      );
      expect(effect).not.toHaveBeenCalled();
    }
  );

  it('runs a check registered by a nested function once, at the outer COMMIT, not when that function returns', async () => {
    const { connection, statements } = fakePoolConnection();
    const check = jest.fn(() => {
      statements.push('CHECK');
    });
    // A service method given the caller's connection, as a profile made
    // inside a rating's transaction or an identity inside a drop's.
    const nested = async (bound: { connection: unknown }) => {
      beforeCommit(bound, 'same', check);
      statements.push('NESTED WRITE');
    };

    await execNativeTransactionally(async (bound) => {
      await nested(bound);
      expect(check).not.toHaveBeenCalled();
      await nested(bound);
      expect(check).not.toHaveBeenCalled();
      statements.push('OUTER WRITE');
    }, connection);

    expect(check).toHaveBeenCalledTimes(1);
    expect(statements).toEqual([
      'BEGIN',
      'NESTED WRITE',
      'NESTED WRITE',
      'OUTER WRITE',
      'CHECK',
      'COMMIT',
      'RELEASE'
    ]);
  });

  describe('a pooled connection reused for the next transaction', () => {
    it.each([
      ['a failing check', 'check'],
      ['an error in the work', 'work'],
      ['a failed COMMIT', 'commit']
    ] as const)('carries no check over after %s', async (_, failingStep) => {
      const { connection, statements } = fakePoolConnection();
      if (failingStep === 'commit') {
        jest
          .spyOn(connection, 'commit')
          .mockImplementationOnce((callback: any) => {
            statements.push('COMMIT FAILED');
            callback(new Error('commit failed'));
          });
      }
      const check = jest.fn(() => {
        if (failingStep === 'check') throw new IdentityFrozenException();
      });

      const first = await settle(
        execNativeTransactionally(async (bound) => {
          beforeCommit(bound, 'k', check);
          if (failingStep === 'work') throw new Error('work failed');
        }, connection)
      );
      expect(first.error).toBeDefined();
      const checksInFirst = check.mock.calls.length;

      statements.length = 0;
      await expect(
        execNativeTransactionally(async () => {
          statements.push('WORK');
          return 'second';
        }, connection)
      ).resolves.toBe('second');

      expect(check).toHaveBeenCalledTimes(checksInFirst);
      expect(statements).toEqual(['BEGIN', 'WORK', 'COMMIT', 'RELEASE']);
    });

    it('carries no check over after a commit', async () => {
      const { connection, statements } = fakePoolConnection();
      const check = jest.fn();

      await execNativeTransactionally(async (bound) => {
        beforeCommit(bound, 'k', check);
      }, connection);
      expect(check).toHaveBeenCalledTimes(1);

      statements.length = 0;
      await execNativeTransactionally(async () => {
        statements.push('WORK');
      }, connection);

      expect(check).toHaveBeenCalledTimes(1);
      expect(statements).toEqual(['BEGIN', 'WORK', 'COMMIT', 'RELEASE']);
    });
  });
});

describe('execNativeTransactionally with an execution budget runs the checks right before COMMIT', () => {
  type Callback = (error: unknown, rows?: unknown) => void;

  function budget(): SqlExecutionBudget {
    return {
      deadlineMonotonicMillis: performance.now() + 5_000,
      maxStatementMillis: 1_000,
      finalizationReserveMillis: 1_000,
      lockWaitSeconds: 1
    };
  }

  /** A pooled connection for the budget executor, which sends plain SQL. */
  function fakeDriver() {
    const statements: string[] = [];
    const release = jest.fn(() => {
      statements.push('RELEASE');
    });
    const destroy = jest.fn(() => {
      statements.push('DESTROY');
    });
    const connection = {
      config: {},
      release,
      destroy,
      query: (input: string | { sql: string }, callback: Callback) => {
        const sql = typeof input === 'string' ? input : input.sql;
        statements.push(sql);
        queueMicrotask(() =>
          callback(
            null,
            sql.startsWith('SELECT @@SESSION')
              ? [{ execution_millis: '0', lock_seconds: '50' }]
              : []
          )
        );
        return new EventEmitter();
      }
    } as unknown as PoolConnection;
    return { connection, statements, release, destroy };
  }

  async function run(
    driver: ReturnType<typeof fakeDriver>,
    work: (bound: { connection: unknown }) => Promise<unknown>
  ) {
    return settle(
      execNativeTransactionally(work, driver.connection, {
        executionBudget: budget()
      })
    );
  }

  const SETUP = [
    'SELECT @@SESSION.max_execution_time AS execution_millis, @@SESSION.innodb_lock_wait_timeout AS lock_seconds',
    'SET SESSION max_execution_time = 1000, innodb_lock_wait_timeout = 1',
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    'START TRANSACTION'
  ];

  it('sends exactly the budget executor statements when nothing is registered, and the same with a passing check', async () => {
    const plain = fakeDriver();
    const checked = fakeDriver();
    const check = jest.fn();

    const withoutCheck = await run(plain, async () => 'done');
    const withCheck = await run(checked, async (bound) => {
      beforeCommit(bound, 'k', check);
      return 'done';
    });

    expect(withoutCheck).toEqual({ value: 'done' });
    expect(withCheck).toEqual({ value: 'done' });
    expect(check).toHaveBeenCalledTimes(1);
    // The budget's session settings retire the connection after COMMIT.
    expect(plain.statements).toEqual([
      ...SETUP,
      'COMMIT',
      'DESTROY',
      'RELEASE'
    ]);
    expect(checked.statements).toEqual(plain.statements);
  });

  it('rolls back on a failing check exactly as on failed work, hands the connection back and rethrows the freeze error', async () => {
    const driver = fakeDriver();
    const failedWork = fakeDriver();
    const failure = new IdentityFrozenException();
    const effect = jest.fn();

    const { error } = await run(driver, async (bound) => {
      beforeCommit(bound, 'k', () => {
        throw failure;
      });
      await afterCommit(bound, effect);
      return 'written';
    });
    await run(failedWork, async () => {
      throw new Error('work failed');
    });

    expect(error).toBe(failure);
    expect(driver.statements).toEqual([
      ...SETUP,
      'ROLLBACK',
      'DESTROY',
      'RELEASE'
    ]);
    expect(driver.statements).toEqual(failedWork.statements);
    expect(effect).not.toHaveBeenCalled();
  });

  it('carries no check over to the next transaction on the same connection', async () => {
    const driver = fakeDriver();
    const check = jest.fn(() => {
      throw new IdentityFrozenException();
    });

    const first = await run(driver, async (bound) => {
      beforeCommit(bound, 'k', check);
    });
    expect(first.error).toBeInstanceOf(IdentityFrozenException);

    driver.statements.length = 0;
    const second = await run(driver, async () => 'second');

    expect(second).toEqual({ value: 'second' });
    expect(check).toHaveBeenCalledTimes(1);
    expect(driver.statements).toContain('COMMIT');
    expect(driver.statements).not.toContain('ROLLBACK');
  });
});
