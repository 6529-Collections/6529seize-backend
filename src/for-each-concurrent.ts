interface ConcurrencyOptions {
  readonly concurrency: number;
  readonly signal?: AbortSignal;
}

/**
 * Consume lazily with bounded concurrency. Continue after individual failures,
 * then report the first error after all started work settles. Cancellation stops
 * new work; the caller passes the signal to its own cancellable operations.
 */
export async function forEachConcurrent<T>(
  items: Iterable<T>,
  visit: (item: T) => Promise<void>,
  { concurrency, signal }: ConcurrencyOptions
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('concurrency must be a positive safe integer');
  const iterator = items[Symbol.iterator]();
  let stopped = false;
  let failed = false;
  let firstError: unknown;
  const recordFailure = (error: unknown) => {
    if (!failed) firstError = error;
    failed = true;
  };
  const takeNext = () => {
    try {
      return iterator.next();
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  await Promise.all(
    Array.from({ length: concurrency }, () =>
      consumeConcurrentItems(
        takeNext,
        visit,
        () => stopped || signal?.aborted === true,
        recordFailure
      )
    )
  );
  if (failed) throw firstError;
}

function consumeConcurrentItems<T>(
  takeNext: () => IteratorResult<T>,
  visit: (item: T) => Promise<void>,
  shouldStop: () => boolean,
  recordFailure: (error: unknown) => void
): Promise<void> {
  return new Promise((resolve) => {
    const advance = (): void => {
      if (shouldStop()) {
        resolve();
        return;
      }
      // Claim work only when this worker is free. Promise settlement schedules
      // the next item, so synchronous callbacks cannot build a recursive stack.
      let work: Promise<void>;
      try {
        const next = takeNext();
        if (next.done) {
          resolve();
          return;
        }
        work = visit(next.value);
      } catch (error) {
        work = Promise.reject(error);
      }
      void Promise.resolve(work).then(advance, (error: unknown) => {
        recordFailure(error);
        advance();
      });
    };
    advance();
  });
}
