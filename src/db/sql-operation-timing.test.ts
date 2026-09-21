import { performance } from 'node:perf_hooks';
import { PoolConnection } from 'mysql';
import { DbPoolName } from '@/db-query.options';
import { execSQLWithConnection } from '@/db/my-sql.helpers';
import { Logger } from '@/logging';
import { loggerContext, LoggerContextValue } from '@/logger-context';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function connectionFixture() {
  let callback!: (error: Error | null, rows?: unknown[]) => void;
  const query = jest.fn((_sql, cb) => {
    callback = cb;
  });
  const release = jest.fn();
  const connection = {
    config: {},
    query,
    release
  } as unknown as PoolConnection;
  return {
    connection,
    query,
    release,
    succeed: (rows: unknown[] = [{ id: 'ok' }]) => callback(null, rows),
    fail: (error: Error) => callback(error)
  };
}

describe('SQL operation timing', () => {
  const warn = jest.fn();
  const error = jest.fn();
  const contexts: (LoggerContextValue | undefined)[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.spyOn(performance, 'now').mockImplementation(() => Date.now());
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => {
      contexts.push(loggerContext.get());
      warn(...args);
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(error);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    warn.mockClear();
    error.mockClear();
    contexts.length = 0;
  });

  it('reports a pending acquisition before a request deadline, then correlates fast SQL completion', async () => {
    const acquired = deferred<PoolConnection>();
    const fixture = connectionFixture();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const operation = loggerContext.run(
      { requestId: 'originating-request' },
      () =>
        execSQLWithConnection(
          'SELECT id FROM identities WHERE profile_id=:id',
          {
            pool: DbPoolName.READ,
            acquire: () => acquired.promise
          },
          { id: 'profile' }
        )
    );
    const timer = timeoutSpy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);

    await jest.advanceTimersByTimeAsync(12_000);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'pending',
      stage: 'acquisition',
      pool: 'READ',
      acquisition_ms: 1000,
      sql_ms: null,
      total_ms: 1000
    });
    loggerContext.run({ requestId: 'another-request' }, () => {
      acquired.resolve(fixture.connection);
    });
    await jest.advanceTimersByTimeAsync(10);
    fixture.succeed();
    await expect(operation).resolves.toEqual([{ id: 'ok' }]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({
      operation_id: warn.mock.calls[0][1].operation_id,
      outcome: 'completed',
      acquisition_ms: 12_000,
      sql_ms: 10,
      total_ms: 12_010
    });
    expect(contexts).toEqual([
      { requestId: 'originating-request' },
      { requestId: 'originating-request' }
    ]);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('emits one terminal slow-query message for slow SQL with a fast acquisition', async () => {
    const fixture = connectionFixture();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      pool: DbPoolName.WRITE,
      acquire: async () => fixture.connection
    });
    await jest.advanceTimersByTimeAsync(1500);
    fixture.succeed();
    await operation;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toMatchObject({
      stage: 'sql',
      acquisition_ms: 0,
      sql_ms: 1000
    });
    expect(warn.mock.calls[1]).toEqual([
      'SQL query took 1500 ms to execute: SELECT id FROM profiles',
      expect.objectContaining({
        outcome: 'completed',
        pool: 'WRITE',
        acquisition_ms: 0,
        sql_ms: 1500,
        total_ms: 1500
      })
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses total duration when acquisition and SQL are each under the threshold', async () => {
    const fixture = connectionFixture();
    const acquired = deferred<PoolConnection>();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      pool: DbPoolName.READ,
      acquire: () => acquired.promise
    });
    await jest.advanceTimersByTimeAsync(600);
    acquired.resolve(fixture.connection);
    await jest.advanceTimersByTimeAsync(600);
    fixture.succeed();
    await operation;
    expect(warn.mock.calls[1][1]).toMatchObject({
      acquisition_ms: 600,
      sql_ms: 600,
      total_ms: 1200
    });
  });

  it('keeps fast operations quiet and cancels the pending timer', async () => {
    const fixture = connectionFixture();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      pool: DbPoolName.READ,
      acquire: async () => fixture.connection
    });
    await jest.advanceTimersByTimeAsync(5);
    fixture.succeed();
    await operation;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps result processing in total duration and out of SQL execution time', async () => {
    const fixture = connectionFixture();
    const acquired = deferred<PoolConnection>();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      pool: DbPoolName.READ,
      acquire: () => acquired.promise
    });
    await jest.advanceTimersByTimeAsync(200);
    acquired.resolve(fixture.connection);
    await jest.advanceTimersByTimeAsync(500);
    fixture.succeed([
      {
        toJSON: () => {
          jest.setSystemTime(1500);
          return { id: 'ok' };
        }
      }
    ]);
    await expect(operation).resolves.toEqual([{ id: 'ok' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'completed',
      acquisition_ms: 200,
      sql_ms: 500,
      total_ms: 1500
    });
  });

  it('logs slow acquisition with fast SQL even if the pending timer has not run', async () => {
    const fixture = connectionFixture();
    const acquired = deferred<PoolConnection>();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      pool: DbPoolName.READ,
      acquire: () => acquired.promise
    });
    // Simulate elapsed time before the event loop gets to the watchdog callback.
    jest.setSystemTime(1500);
    acquired.resolve(fixture.connection);
    await Promise.resolve();
    fixture.succeed();
    await operation;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'completed',
      acquisition_ms: 1500,
      sql_ms: 0,
      total_ms: 1500
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([10, 2000])(
    'records acquisition failure at %i ms without executing SQL or leaking error details',
    async (delay) => {
      const acquired = deferred<PoolConnection>();
      const failure = new Error('private-driver-detail');
      const operation = execSQLWithConnection(
        "SELECT * FROM membership_refresh_runs WHERE lease_token='inline-secret'",
        { pool: DbPoolName.READ, acquire: () => acquired.promise },
        { token: 'bound-secret' }
      );
      const rejected = expect(operation).rejects.toBe(failure);
      await jest.advanceTimersByTimeAsync(delay);
      acquired.reject(failure);
      await rejected;
      expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({
        outcome: 'failed',
        stage: 'acquisition',
        acquisition_ms: delay,
        sql_ms: null,
        total_ms: delay
      });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /inline-secret|bound-secret|private-driver-detail|SELECT/
      );
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each([10, 1500])(
    'preserves SQL errors and clears the pending timer after %i ms',
    async (delay) => {
      const fixture = connectionFixture();
      const failure = new Error('query failed');
      const operation = execSQLWithConnection('SELECT id FROM profiles', {
        pool: DbPoolName.READ,
        acquire: async () => fixture.connection
      });
      const rejected = expect(operation).rejects.toBe(failure);
      await jest.advanceTimersByTimeAsync(delay);
      fixture.fail(failure);
      await rejected;
      expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({
        outcome: 'failed',
        stage: 'sql',
        sql_ms: delay
      });
      expect(warn.mock.calls.at(-1)?.[0]).toBe(
        delay > 1000
          ? `SQL query took ${delay} ms to execute: SELECT id FROM profiles`
          : 'SQL operation failed: SELECT id FROM profiles'
      );
      expect(error).toHaveBeenCalledTimes(1);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('does not invent acquisition time or release a supplied transaction connection', async () => {
    const fixture = connectionFixture();
    const operation = execSQLWithConnection('SELECT id FROM profiles', {
      connection: fixture.connection
    });
    await jest.advanceTimersByTimeAsync(1200);
    fixture.succeed();
    await operation;
    for (const [, details] of warn.mock.calls) {
      expect(details).toMatchObject({ pool: 'supplied', acquisition_ms: null });
    }
    expect(warn.mock.calls[1][1]).toMatchObject({
      sql_ms: 1200,
      total_ms: 1200
    });
    expect(fixture.release).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up after a synchronous acquisition exception', async () => {
    const failure = new Error('synchronous failure');
    await expect(
      execSQLWithConnection('SELECT 1', {
        pool: DbPoolName.READ,
        acquire: () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'failed',
      stage: 'acquisition'
    });
  });

  it('cleans up if the driver throws before registering its callback', async () => {
    const fixture = connectionFixture();
    const failure = new Error('synchronous query failure');
    fixture.query.mockImplementation(() => {
      throw failure;
    });
    await expect(
      execSQLWithConnection('SELECT 1', { connection: fixture.connection })
    ).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'failed',
      stage: 'sql',
      acquisition_ms: null
    });
  });

  it('records a budget setup failure without inventing SQL or acquisition time', async () => {
    const fixture = connectionFixture();
    await expect(
      execSQLWithConnection(
        'SELECT 1',
        { connection: fixture.connection },
        undefined,
        {
          statementLimits: {
            deadlineMonotonicMillis: 100,
            maxStatementMillis: 10
          }
        }
      )
    ).rejects.toThrow();
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(warn.mock.calls[0][1]).toMatchObject({
      outcome: 'failed',
      stage: 'sql_setup',
      acquisition_ms: null,
      sql_ms: null
    });
  });

  it('preserves the operation outcome if pending or terminal logging fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logging failed');
    });
    const fixture = connectionFixture();
    const operation = execSQLWithConnection('SELECT 1', {
      connection: fixture.connection
    });
    await jest.advanceTimersByTimeAsync(1500);
    fixture.succeed();
    await expect(operation).resolves.toEqual([{ id: 'ok' }]);
    const failure = new Error('acquisition failed');
    await expect(
      execSQLWithConnection('SELECT 1', {
        pool: DbPoolName.READ,
        acquire: async () => {
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'artwork_documentation_assets',
    'market_depth_events',
    'content_moderation_items',
    'abusiveness_detection_results',
    'profile_cms_agent_grants',
    'membership_generation_members'
  ])('redacts pending and terminal SQL for %s', async (table) => {
    const fixture = connectionFixture();
    const operation = execSQLWithConnection(
      `SELECT * FROM ${table} WHERE payload='inline-secret' AND id=:id`,
      { connection: fixture.connection },
      { id: 'bound-secret' }
    );
    await jest.advanceTimersByTimeAsync(1500);
    fixture.succeed();
    await operation;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /inline-secret|bound-secret|SELECT/
    );
  });
});
