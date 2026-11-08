import {
  DeadlineEvent,
  DeadlineMiss,
  LATE_TIMER_MS,
  withRedisDeadline
} from './redis-command-deadline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type Missed = Error & { miss: DeadlineMiss; lateMs: number };

/** Starts a 500 ms deadline over `work` and records how it settles. */
function start<T>(work: Promise<T>) {
  const events: DeadlineEvent[] = [];
  const startedAt = Date.now();
  const result: {
    settled: boolean;
    value?: T;
    error?: unknown;
    atMs?: number;
  } = { settled: false };
  withRedisDeadline(work, {
    operation: 'SET',
    timeoutMs: 500,
    timeoutError: (miss, lateMs) =>
      Object.assign(new Error(`${miss} ${lateMs}`), { miss, lateMs }),
    report: (event) => events.push(event)
  }).then(
    (value) => {
      Object.assign(result, {
        settled: true,
        value,
        atMs: Date.now() - startedAt
      });
    },
    (error: unknown) => {
      Object.assign(result, {
        settled: true,
        error,
        atMs: Date.now() - startedAt
      });
    }
  );
  return { events, result };
}

/** Wall time passes while no timer runs, as in a frozen Lambda container. */
const freeze = (ms: number) => jest.setSystemTime(Date.now() + ms);

describe('withRedisDeadline', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('resolves a reply that arrives within the budget and leaves no timer', async () => {
    const reply = deferred<string>();
    const { events, result } = start(reply.promise);
    jest.advanceTimersByTime(10);
    reply.resolve('OK');
    await flush();
    expect(result).toMatchObject({ settled: true, value: 'OK' });
    expect(jest.getTimerCount()).toBe(0);
    expect(events).toEqual([]);
  });

  it('(b) still rejects a genuinely slow command at its 500 ms deadline, as slow', async () => {
    const { events, result } = start(new Promise<string>(() => undefined));
    jest.advanceTimersByTime(499);
    await flush();
    expect(result.settled).toBe(false);
    jest.advanceTimersByTime(1);
    // The rejection runs in the same loop iteration (check phase).
    jest.runOnlyPendingTimers();
    await flush();
    expect(result.settled).toBe(true);
    // One loop turn after the deadline (fake immediates advance 1 ms).
    expect(result.atMs).toBeGreaterThanOrEqual(500);
    expect(result.atMs).toBeLessThanOrEqual(501);
    expect((result.error as Missed).miss).toBe('slow');
    expect(events).toEqual([
      { operation: 'SET', outcome: 'slow', overdueMs: 0 }
    ]);
  });

  it('(a) lets a reply already readable when the timer fires win: it settles one loop turn later', async () => {
    const reply = deferred<string>();
    const { events, result } = start(reply.promise);
    // The timer fires on time; its rejection waits for the check phase.
    jest.advanceTimersToNextTimer();
    expect(jest.getTimerCount()).toBe(1);
    // The reply is read in the poll phase, before that.
    reply.resolve('OK');
    await flush();
    jest.runOnlyPendingTimers();
    await flush();
    expect(result).toMatchObject({ settled: true, value: 'OK' });
    expect(events).toEqual([]);
  });

  it('(a) resolves a reply that arrives after a freeze, counting the late timer as recovered', async () => {
    const reply = deferred<string>();
    const { events, result } = start(reply.promise);
    freeze(2_000);
    // On thaw the expired timer runs first. Late by 2 s: not Redis's budget.
    jest.advanceTimersToNextTimer();
    await flush();
    expect(result.settled).toBe(false);
    reply.resolve('OK');
    await flush();
    expect(result).toMatchObject({ settled: true, value: 'OK' });
    expect(events).toEqual([
      { operation: 'SET', outcome: 'suspended_recovered', overdueMs: 2_000 }
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('(c) labels a late timer whose fresh budget also runs out as suspended, not slow', async () => {
    const { events, result } = start(new Promise<string>(() => undefined));
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    await flush();
    expect(result.settled).toBe(false);
    jest.advanceTimersByTime(500);
    jest.runOnlyPendingTimers();
    await flush();
    expect(result.settled).toBe(true);
    expect(result.error as Missed).toMatchObject({
      miss: 'suspended_timeout',
      lateMs: 2_000
    });
    expect(events).toEqual([
      { operation: 'SET', outcome: 'suspended_timeout', overdueMs: 2_000 }
    ]);
  });

  it('gives a late timer one fresh budget only', async () => {
    const { result } = start(new Promise<string>(() => undefined));
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    freeze(3_000);
    jest.advanceTimersToNextTimer();
    jest.runOnlyPendingTimers();
    await flush();
    expect(result.error as Missed).toMatchObject({
      miss: 'suspended_timeout',
      lateMs: 2_000
    });
  });

  it(`treats a timer up to ${LATE_TIMER_MS} ms late as on time`, async () => {
    const { result } = start(new Promise<string>(() => undefined));
    freeze(LATE_TIMER_MS);
    jest.advanceTimersToNextTimer();
    jest.runOnlyPendingTimers();
    await flush();
    expect((result.error as Missed).miss).toBe('slow');
  });

  it('passes a Redis error through unchanged, without an event', async () => {
    const reply = deferred<string>();
    const { events, result } = start(reply.promise);
    const wrongType = new Error('WRONGTYPE');
    reply.reject(wrongType);
    await flush();
    expect(result.error).toBe(wrongType);
    expect(events).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never lets a reporting failure change the outcome', async () => {
    const reply = deferred<string>();
    let value: string | undefined;
    withRedisDeadline(reply.promise, {
      operation: 'GET',
      timeoutMs: 500,
      timeoutError: () => new Error('timeout'),
      report: () => {
        throw new Error('stdout closed');
      }
    }).then((v) => (value = v));
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    reply.resolve('hit');
    await flush();
    expect(value).toBe('hit');
  });
});
