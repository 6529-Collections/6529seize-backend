import { getRedisClient } from '@/redis';
import {
  withBatchPreflightLimit,
  MARKET_BATCH_PREFLIGHT_TIMEOUT_MS
} from './market-batch-preflight-limit';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));
const redis = jest.mocked(getRedisClient);
let evaluate: jest.Mock;
beforeEach(() => {
  evaluate = jest.fn().mockResolvedValue(1);
  redis.mockReturnValue({
    isReady: true,
    eval: evaluate
  } as unknown as NonNullable<ReturnType<typeof getRedisClient>>);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
function fastDeadline() {
  const original = global.setTimeout;
  jest
    .spyOn(global, 'setTimeout')
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      original(
        callback,
        delay === MARKET_BATCH_PREFLIGHT_TIMEOUT_MS ? 5 : delay,
        ...args
      )) as typeof setTimeout);
}

test('acquires before work, passes a live signal and releases only its own lease token', async () => {
  let signal: AbortSignal | undefined;
  const result = await withBatchPreflightLimit(
    'profile:wallet',
    'operation',
    async (active) => {
      signal = active;
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(active.aborted).toBe(false);
      return 9;
    }
  );
  expect(result).toBe(9);
  expect(signal?.aborted).toBe(true);
  const acquire = evaluate.mock.calls[0][1];
  const release = evaluate.mock.calls[1][1];
  expect(release.keys).toEqual([acquire.keys[0]]);
  expect(release.arguments).toEqual([acquire.arguments[0]]);
  expect(Number(acquire.arguments[1])).toBeGreaterThan(
    MARKET_BATCH_PREFLIGHT_TIMEOUT_MS
  );
  const tags = acquire.keys.map((key: string) => key.match(/\{([^}]+)\}/)?.[1]);
  expect(new Set(tags).size).toBe(1);
  expect(tags[0]).toMatch(/^[0-9a-f]{64}$/);
});

test('same actor shares lease/counter across operations; other actors have isolated cluster slots', async () => {
  await withBatchPreflightLimit('actor-a', 'one', async () => 1);
  await withBatchPreflightLimit('actor-a', 'two', async () => 1);
  await withBatchPreflightLimit('actor-b', 'one', async () => 1);
  const first = evaluate.mock.calls[0][1].keys;
  const same = evaluate.mock.calls[2][1].keys;
  const other = evaluate.mock.calls[4][1].keys;
  expect(first[0]).toBe(same[0]);
  expect(first[2]).toBe(same[2]);
  expect(first[1]).not.toBe(same[1]);
  expect(first[0]).not.toBe(other[0]);
});

test.each(['absent', 'not ready', 'error', 'invalid response'])(
  'fails closed when Redis is %s',
  async (kind) => {
    if (kind === 'absent') redis.mockReturnValue(null);
    if (kind === 'not ready')
      redis.mockReturnValue({ isReady: false } as NonNullable<
        ReturnType<typeof getRedisClient>
      >);
    if (kind === 'error')
      evaluate.mockRejectedValue(new Error('private transport details'));
    if (kind === 'invalid response') evaluate.mockResolvedValue(null);
    const work = jest.fn();
    await expect(
      withBatchPreflightLimit('actor', 'op', work)
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  }
);

test('returns 429 and never simulates when the distributed lease or cooldown refuses acquisition', async () => {
  evaluate.mockResolvedValueOnce(0);
  const work = jest.fn();
  await expect(
    withBatchPreflightLimit('actor', 'op', work)
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(work).not.toHaveBeenCalled();
  expect(evaluate.mock.calls[1][1].arguments).toEqual([
    evaluate.mock.calls[0][1].arguments[0]
  ]);
});

test('aborts actual work at the deadline and returns a sanitized failure', async () => {
  fastDeadline();
  let signal: AbortSignal | undefined;
  const request = withBatchPreflightLimit('actor', 'op', async (active) => {
    signal = active;
    await new Promise<void>((resolve) =>
      active.addEventListener('abort', () => resolve(), { once: true })
    );
    active.throwIfAborted();
    return 'must not return';
  });
  await expect(request).rejects.toMatchObject({ code: 'MARKET_UNAVAILABLE' });
  expect(signal?.aborted).toBe(true);
});

test('late lease acquisition after timeout cannot start simulation and is safely released', async () => {
  fastDeadline();
  let release: (value: number) => void = () => undefined;
  evaluate.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      })
  );
  const work = jest.fn();
  await expect(
    withBatchPreflightLimit('actor', 'op', work)
  ).rejects.toMatchObject({ code: 'MARKET_UNAVAILABLE' });
  release(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(work).not.toHaveBeenCalled();
  expect(evaluate).toHaveBeenCalledTimes(2);
});
