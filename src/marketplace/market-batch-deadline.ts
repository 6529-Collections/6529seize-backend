import { MarketValidationError } from '@/marketplace/provider.types';

/** Leave time for authentication and durable journal writes inside the API deadline. */
export const MARKET_BATCH_PREPARATION_TIMEOUT_MS = 20000;
export const MARKET_BATCH_NETWORK_CONCURRENCY = 8;

export function assertMarketBatchActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new MarketValidationError(
      'PROVIDER_UNAVAILABLE',
      'The complete batch could not be prepared in time. Refresh or reduce the selection. No wallet request was made.'
    );
}

export async function withMarketBatchDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const expires = Date.now() + MARKET_BATCH_PREPARATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        try {
          assertMarketBatchActive(controller.signal);
        } catch (error) {
          reject(error);
        }
      }, MARKET_BATCH_PREPARATION_TIMEOUT_MS);
    });
    const result = await Promise.race([work(controller.signal), timeout]);
    if (Date.now() >= expires) controller.abort();
    assertMarketBatchActive(controller.signal);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export async function mapMarketBatch<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let index = 0;
  let failed = false;
  async function worker() {
    while (!failed && index < items.length) {
      assertMarketBatchActive(signal);
      const position = index++;
      try {
        result[position] = await task(items[position], position);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, MARKET_BATCH_NETWORK_CONCURRENCY) },
      worker
    )
  );
  assertMarketBatchActive(signal);
  return result;
}
