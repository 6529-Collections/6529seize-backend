import { Logger } from '@/logging';

const logger = Logger.get('WAVE_CACHE_METRICS');

export type WaveCacheName = 'wave_unread_summary' | 'wave_overview_static';

/**
 * Per-lookup counts, one per wave entry:
 * - hit: served from Redis.
 * - miss: computed from the database and stored.
 * - settling: computed from the database and not stored, because a version
 *   it depends on changed moments ago (see the cache module).
 * - error: Redis could not be read; every entry was computed from the
 *   database.
 */
export interface WaveCacheLookupCounts {
  readonly hit?: number;
  readonly miss?: number;
  readonly settling?: number;
  readonly error?: number;
}

export function metricEnvironment(): 'staging' | 'prod' | 'unknown' {
  if ((process.env.SENTRY_ENVIRONMENT ?? '').includes('staging'))
    return 'staging';
  // Production runs only in us-east-1; anything else is not counted as prod.
  return process.env.AWS_REGION === 'us-east-1' ? 'prod' : 'unknown';
}

/**
 * One EMF record per lookup in `6529/ApiCache`, with the cache name as the
 * Route dimension, so per-entry hit rates show next to the response caches.
 */
export function recordWaveCacheLookup(
  cache: WaveCacheName,
  counts: WaveCacheLookupCounts
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/ApiCache',
              Dimensions: [['Environment', 'Route']],
              Metrics: [
                { Name: 'CacheHit', Unit: 'Count' },
                { Name: 'CacheMiss', Unit: 'Count' },
                { Name: 'CacheSettling', Unit: 'Count' },
                { Name: 'CacheError', Unit: 'Count' }
              ]
            }
          ]
        },
        Environment: metricEnvironment(),
        Route: cache,
        CacheHit: counts.hit ?? 0,
        CacheMiss: counts.miss ?? 0,
        CacheSettling: counts.settling ?? 0,
        CacheError: counts.error ?? 0
      })}\n`
    );
  } catch {
    logger.warn('Wave cache telemetry could not be emitted');
  }
}
