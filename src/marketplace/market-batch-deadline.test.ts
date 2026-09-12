import {
  mapMarketBatch,
  withMarketBatchDeadline,
  MARKET_BATCH_PREPARATION_TIMEOUT_MS,
  MARKET_BATCH_NETWORK_CONCURRENCY
} from '@/marketplace/market-batch-deadline';

describe('bounded batch preparation', () => {
  afterEach(() => jest.useRealTimers());
  test('bounds concurrency and preserves selection order', async () => {
    let active = 0,
      peak = 0;
    const result = await mapMarketBatch(
      Array.from({ length: 128 }, (_, i) => i),
      new AbortController().signal,
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return i;
      }
    );
    expect(peak).toBe(MARKET_BATCH_NETWORK_CONCURRENCY);
    expect(result).toEqual(Array.from({ length: 128 }, (_, i) => i));
  });
  test('stops starting new quotes after a selected order fails', async () => {
    const task = jest.fn(async () => {
      throw new Error('stale');
    });
    await expect(
      mapMarketBatch(Array(128).fill(0), new AbortController().signal, task)
    ).rejects.toThrow('stale');
    expect(task).toHaveBeenCalledTimes(MARKET_BATCH_NETWORK_CONCURRENCY);
  });
  test('aborts the provider and fails explicitly at the deadline', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const promise = withMarketBatchDeadline((s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const rejected = expect(promise).rejects.toThrow('No wallet request');
    await jest.advanceTimersByTimeAsync(MARKET_BATCH_PREPARATION_TIMEOUT_MS);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  test('checks elapsed wall time after synchronous validation work', async () => {
    jest.useFakeTimers();
    await expect(
      withMarketBatchDeadline(async () => {
        jest.setSystemTime(
          Date.now() + MARKET_BATCH_PREPARATION_TIMEOUT_MS + 1
        );
        return 1;
      })
    ).rejects.toThrow('No wallet request');
  });
});
