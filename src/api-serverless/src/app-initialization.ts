import type { RedisFailFastOptions } from '@/redis';

/**
 * Request-path Redis budget for the API. Redis is a cache and rate-limit
 * store here, so an unreachable Redis must cost a request at most this much
 * instead of holding it until the Lambda/API Gateway timeout.
 */
export const API_REDIS_FAIL_FAST_OPTIONS: RedisFailFastOptions = {
  commandTimeoutMs: 500,
  connectTimeoutMs: 2_000,
  initialConnectTimeoutMs: 2_000,
  maxReconnectDelayMs: 2_000
};

export interface RetryableInitializerSteps {
  /** Idempotent setup that may fail transiently (config, DB, secrets, Redis). */
  readonly prepare: () => Promise<void>;
  /** One-shot Express wiring. Never re-run: a retry would register twice. */
  readonly wire: () => void;
  readonly onFailure: (error: unknown) => void;
}

/**
 * Shares one in-flight initialization between callers. A failure in prepare
 * is forgotten so the next caller retries in the same warm container; a
 * failure in wire is kept, because wiring may have partially registered
 * middleware and is not safe to repeat.
 */
export function createRetryableInitializer({
  prepare,
  wire,
  onFailure
}: RetryableInitializerSteps): () => Promise<void> {
  let initialization: Promise<void> | null = null;
  let wiringFailed = false;

  async function initialize(): Promise<void> {
    await prepare();
    try {
      wire();
    } catch (error) {
      wiringFailed = true;
      throw error;
    }
  }

  return () => {
    if (initialization) {
      return initialization;
    }
    const attempt = initialize().catch((error: unknown) => {
      onFailure(error);
      if (!wiringFailed) {
        initialization = null;
      }
      throw error;
    });
    initialization = attempt;
    return attempt;
  };
}
