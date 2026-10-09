import { AsyncLocalStorage } from 'node:async_hooks';

const remainingTime = new AsyncLocalStorage<() => number>();

/** Keep the invocation budget available to shared I/O without retaining a Context. */
export function withLambdaRemainingTime<T>(
  getRemainingTime: () => number,
  run: () => T
): T {
  return remainingTime.run(getRemainingTime, run);
}

/** Read the current invocation budget, or leave non-Lambda callers unconstrained. */
export function getLambdaRemainingTime(): number {
  return remainingTime.getStore()?.() ?? Infinity;
}
