import type { RedisFailFastOptions } from './redis';

/**
 * The fail-fast helpers under a frozen container or a stalled event loop:
 * a late timer must neither be reported as Redis being slow nor turn a
 * command that really missed its deadline (a lease above all) into success.
 */

const FAIL_FAST: RedisFailFastOptions = {
  commandTimeoutMs: 500,
  connectTimeoutMs: 1_000,
  initialConnectTimeoutMs: 1_000,
  maxReconnectDelayMs: 2_000
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function flushUntil(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

/** Wall time passes while no timer runs, as in a frozen Lambda container. */
const freeze = (ms: number) => jest.setSystemTime(Date.now() + ms);

const logger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  errorWithDiagnostic: jest.fn(),
  debug: jest.fn()
};

async function loadRedis() {
  const client = {
    isReady: true,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn()
  };
  jest.doMock('redis', () => ({ createClient: () => client }));
  jest.doMock('./logging', () => ({ Logger: { get: () => logger } }));
  const redis = await import('./redis');
  await redis.initRedis({ failFast: FAIL_FAST });
  return { redis, client };
}

const warnings = () => logger.warn.mock.calls.map(([message]) => message);

describe('fail-fast Redis helpers with late timers', () => {
  const originalEnv = { ...process.env };
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    process.env.AWS_REGION = 'us-east-1';
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
    stdout.mockRestore();
    process.env = { ...originalEnv };
  });

  const outcomes = () =>
    stdout.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"6529/Redis"'))
      .map((line) => JSON.parse(line).Outcome);

  it('reports a post-response SET whose reply arrives after a thaw as recovered, not as a timeout', async () => {
    const { redis, client } = await loadRedis();
    const reply = deferred<string>();
    client.set.mockReturnValue(reply.promise);
    let done = false;
    redis.redisSetJson('cache', { body: 'x' }).then(() => (done = true));
    await flushUntil(() => client.set.mock.calls.length === 1);
    freeze(1_200);
    jest.advanceTimersToNextTimer();
    reply.resolve('OK');
    await flush();
    expect(done).toBe(true);
    expect(warnings()).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Redis SET timer fired 1200ms late .*the reply arrived$/
      )
    );
    expect(outcomes()).toEqual(['suspended_recovered']);
  });

  it('still warns that Redis is slow when a SET misses its deadline on time', async () => {
    const { redis, client } = await loadRedis();
    client.set.mockReturnValue(new Promise(() => undefined));
    let done = false;
    redis.redisSetJson('cache', { body: 'x' }).then(() => (done = true));
    await flushUntil(() => client.set.mock.calls.length === 1);
    jest.advanceTimersByTime(500);
    jest.runOnlyPendingTimers();
    await flush();
    expect(done).toBe(true);
    expect(warnings()).toEqual([
      'Redis SET timed out after 500ms; continuing without Redis'
    ]);
    expect(outcomes()).toEqual(['slow']);
  });

  it('keeps a slow-Redis warning visible right after a suspended one (separate rate limits)', async () => {
    const { redis, client } = await loadRedis();
    client.set.mockReturnValue(new Promise(() => undefined));
    redis.redisSetJson('a', 1);
    await flushUntil(() => client.set.mock.calls.length === 1);
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    jest.advanceTimersByTime(500);
    jest.runOnlyPendingTimers();
    await flush();
    redis.redisSetJson('b', 2);
    await flushUntil(() => client.set.mock.calls.length === 2);
    jest.advanceTimersByTime(500);
    jest.runOnlyPendingTimers();
    await flush();
    expect(warnings()).toEqual([
      'Redis SET got no reply within a 100ms grace after its timer fired 2000ms late (process suspended or event loop stalled); continuing without Redis',
      'Redis SET timed out after 500ms; continuing without Redis'
    ]);
    expect(outcomes()).toEqual(['suspended_timeout', 'slow']);
  });

  describe('SET NX leases', () => {
    it('reports a lease Redis granted while the container was frozen as acquired', async () => {
      const { redis, client } = await loadRedis();
      const reply = deferred<string | null>();
      client.set.mockReturnValue(reply.promise);
      let acquired: boolean | null | undefined;
      redis
        .redisSetIfAbsent('lease', { toSeconds: () => 60 } as never)
        .then((value) => (acquired = value));
      await flushUntil(() => client.set.mock.calls.length === 1);
      freeze(3_000);
      jest.advanceTimersToNextTimer();
      reply.resolve('OK');
      await flush();
      expect(acquired).toBe(true);
    });

    it('never reports a lease whose reply came too late as acquired, even when Redis set it', async () => {
      const { redis, client } = await loadRedis();
      const reply = deferred<string | null>();
      client.set.mockReturnValue(reply.promise);
      let acquired: boolean | null | undefined;
      redis
        .redisSetIfAbsent('lease', { toSeconds: () => 60 } as never)
        .then((value) => (acquired = value));
      await flushUntil(() => client.set.mock.calls.length === 1);
      jest.advanceTimersByTime(500);
      jest.runOnlyPendingTimers();
      await flush();
      expect(acquired).toBeNull();
      // Redis did set it, after the deadline: the answer stays "unknown".
      reply.resolve('OK');
      await flush();
      expect(acquired).toBeNull();
    });

    it('the viewer group set write lease: a timed-out lease writes nothing, a thawed one writes', async () => {
      const { redis, client } = await loadRedis();
      const { ViewerGroupSets } = await import('./waves/viewer-group-sets');
      const { DB_TEXT_COLLATION } = await import('./db/db-collation');
      const large = Array.from(
        { length: 400 },
        (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      );
      const db = () => {
        const writes = jest.fn(async () => {
          throw new Error('stop after the lease');
        });
        return {
          writes,
          db: {
            execute: jest.fn(async (sql: string) =>
              sql.includes('information_schema.columns')
                ? [{ collation_name: DB_TEXT_COLLATION }]
                : []
            ),
            executeNativeQueriesInTransaction: writes
          } as never
        };
      };
      const run = async (whenSetIsCalled: () => void) => {
        const reply = deferred<string | null>();
        client.set.mockReturnValueOnce(reply.promise);
        const target = db();
        const sets = new ViewerGroupSets(
          redis.redisSetIfAbsent,
          () => true,
          () => 1_000_000
        );
        const calls = client.set.mock.calls.length;
        const source = sets.source(target.db, 'x_groups', large);
        await flushUntil(() => client.set.mock.calls.length === calls + 1);
        whenSetIsCalled();
        reply.resolve('OK');
        await flush();
        await source;
        return target.writes;
      };
      // Redis is slow: the lease's reply misses the deadline. Not acquired.
      const slow = await run(() => {
        jest.advanceTimersByTime(500);
        jest.runOnlyPendingTimers();
      });
      expect(slow).not.toHaveBeenCalled();
      expect(client.set.mock.calls[0][0]).toMatch(/^viewer_group_set:write:/);
      // The container was frozen with the lease's reply on its way: acquired.
      const thawed = await run(() => {
        freeze(2_000);
        jest.advanceTimersToNextTimer();
      });
      expect(thawed).toHaveBeenCalledTimes(1);
    });
  });
});
