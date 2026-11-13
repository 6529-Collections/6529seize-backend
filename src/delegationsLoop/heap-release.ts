import { Logger } from '../logging';

const logger = Logger.get('DELEGATIONS_LOOP');

const MB = 1024 * 1024;

const mb = (bytes: number) => Math.round(bytes / MB);

/** What made an invocation heavy enough to collect after. */
export type HeavyRun = 'RECONSOLIDATION' | 'IDENTITIES SYNC';

/**
 * A full garbage collection at the end of a heavy invocation (one that
 * reconsolidated, or resumed an identities sync). Lambda freezes a warm
 * sandbox between invocations, so V8 never gets idle time to collect a run's
 * garbage: the next run allocates on top of it, and the instance's memory
 * high-water mark (Max Memory Used) creeps up run after run. Collecting here
 * starts the next run from the live heap. `gc` is exposed by `--expose-gc`
 * (NODE_OPTIONS in serverless.yaml); without it, this only logs that it was
 * skipped. It runs in the handler's `finally`, so it never throws: a failure
 * is only logged, and the invocation's result or error stands.
 */
export function collectGarbageAfter(run: HeavyRun): void {
  try {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') {
      logger.warn(`[GC AFTER ${run}] [SKIPPED: GC NOT EXPOSED]`);
      return;
    }
    const before = process.memoryUsage();
    const started = Date.now();
    gc();
    const elapsed = Date.now() - started;
    const after = process.memoryUsage();
    logger.info(
      `[GC AFTER ${run}] [${elapsed}ms] [HEAP ${mb(before.heapUsed)} -> ${mb(after.heapUsed)} MB] [RSS ${mb(before.rss)} -> ${mb(after.rss)} MB]`
    );
  } catch (error) {
    try {
      logger.warn(`[GC AFTER ${run}] [FAILED] ${error}`);
    } catch {
      // Not even the logger works: nothing left to report the failure to.
    }
  }
}
