import { Logger } from '../logging';

const logger = Logger.get('DELEGATIONS_LOOP');

const MB = 1024 * 1024;

const mb = (bytes: number) => Math.round(bytes / MB);

/**
 * A full garbage collection at the end of an invocation that reconsolidated.
 * Lambda freezes a warm sandbox between invocations, so V8 never gets idle
 * time to collect a run's garbage: the next run allocates on top of it, and
 * the instance's memory high-water mark (Max Memory Used) creeps up run after
 * run. Collecting here starts the next run from the live heap. `gc` is
 * exposed by `--expose-gc` (NODE_OPTIONS in serverless.yaml); without it,
 * this only logs that it was skipped.
 */
export function releaseHeapAfterReconsolidation(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    logger.warn('[GC AFTER RECONSOLIDATION] [SKIPPED: GC NOT EXPOSED]');
    return;
  }
  const before = process.memoryUsage();
  const started = Date.now();
  gc();
  const elapsed = Date.now() - started;
  const after = process.memoryUsage();
  logger.info(
    `[GC AFTER RECONSOLIDATION] [${elapsed}ms] [HEAP ${mb(before.heapUsed)} -> ${mb(after.heapUsed)} MB] [RSS ${mb(before.rss)} -> ${mb(after.rss)} MB]`
  );
}
