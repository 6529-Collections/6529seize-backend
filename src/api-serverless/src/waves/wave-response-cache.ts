import type { NextFunction, Request, Response } from 'express';
import { Time } from '@/time';
import { cacheKey } from '@/api/api-helpers';
import { cacheRequest, type RequestCacheOptions } from '@/api/request-cache';
import type { ApiWave } from '@/api/generated/models/ApiWave';
import { Logger } from '@/logging';
import { evictKeyFromRedisCache } from '@/redis';
import { metricEnvironment } from './wave-cache-metrics';

/**
 * How long an anonymous `GET /waves/:id` response is shared. Anonymous
 * viewers see a public wave's metadata, metrics and description drop up to
 * this much late, and a wave that turns private stays visible to them for at
 * most this long (an update through `POST /waves/:id` evicts it at once).
 */
export const ANONYMOUS_WAVE_RESPONSE_TTL = Time.seconds(15);

const SHAREABLE = 'shareableAnonymousWave';
const ANON_WAVE_KEY_SUFFIX = '__ANON_WAVE';
const AUTH_COOKIE_NAMES = new Set(['wallet-auth', '__host-wallet-auth']);
const logger = Logger.get('WAVE_RESPONSE_CACHE');
const ROUTE_LABEL = 'GET /api/waves/:id';

/**
 * The cache key for one request URL. Reads and evictions both build the key
 * here, so an eviction always hits the entry a read stored.
 */
export function anonymousWaveCacheKey(url: string): string {
  return `${cacheKey({ originalUrl: url } as Request)}${ANON_WAVE_KEY_SUFFIX}`;
}

/** Any request signal that could identify the viewer. */
export function carriesIdentity(req: Request): boolean {
  if (req.user) return true;
  if (req.headers.authorization) return true;
  // A plain split rather than a regex keeps a long cookie header linear.
  return (req.headers.cookie ?? '')
    .split(';')
    .some((cookie) =>
      AUTH_COOKIE_NAMES.has(cookie.split('=', 1)[0].trim().toLowerCase())
    );
}

// 0, false, null and undefined are the anonymous defaults of these fields.
const isSet = (value: unknown) =>
  value !== undefined && value !== null && value !== 0 && value !== false;

/**
 * True when the response holds state that belongs to one viewer: their
 * subscriptions, pin, counts, read position, mute, rep contribution or
 * their own context on the description drop or parent wave. An anonymous
 * response has none of these. A schema test fails when the wave model
 * gains a field this does not account for.
 */
export function carriesViewerState(wave: ApiWave): boolean {
  const metrics = wave.metrics;
  return (
    (wave.subscribed_actions?.length ?? 0) > 0 ||
    wave.pinned === true ||
    isSet(metrics?.your_drops_count) ||
    isSet(metrics?.your_latest_drop_timestamp) ||
    isSet(metrics?.your_participation_drops_count) ||
    isSet(metrics?.your_unread_drops_count) ||
    isSet(metrics?.first_unread_drop_serial_no) ||
    isSet(metrics?.your_latest_read_timestamp) ||
    metrics?.muted === true ||
    isSet(wave.wave_rep?.authenticated_user_contribution) ||
    isSet(wave.description_drop?.context_profile_context) ||
    (wave.description_drop?.subscribed_actions?.length ?? 0) > 0 ||
    isSet(wave.parent_wave?.context_profile_context)
  );
}

/**
 * Called by the handler before it sends: only a wave built for an
 * anonymous context, with no viewer state in it, may be stored.
 */
export function markShareableWaveResponse(
  res: Response,
  viewerProfileId: string | null,
  wave: ApiWave
): void {
  res.locals[SHAREABLE] = viewerProfileId === null && !carriesViewerState(wave);
}

/**
 * Cache options for `GET /waves/:id`. Requests with any identity signal
 * never reach the cache (no read, no fill); the middleware below routes
 * them past it. Only 200 responses the handler marked shareable are stored,
 * so a 304, an error or a viewer's response is never replayed. Express
 * still answers a matching `If-None-Match` with 304 from the cached body.
 * The key is the full URL (path and query); no request header changes this
 * route's body.
 *
 * Sharing one body across anonymous callers is sound because the handler
 * resolves every anonymous caller to the same read context: no profile and
 * no eligible groups. A wave that context cannot read is a 404, never a
 * 200, so only globally public waves are stored.
 */
export const anonymousWaveResponseCacheOptions: RequestCacheOptions = {
  ttl: ANONYMOUS_WAVE_RESPONSE_TTL,
  key: (req: Request) => anonymousWaveCacheKey(req.originalUrl || req.url),
  shouldCacheResponse: (_req, res) =>
    res.statusCode === 200 && res.locals[SHAREABLE] === true
};

type CacheOutcome = 'hit' | 'miss' | 'bypass';

/** One EMF count per request in `6529/ApiCache`, so the hit rate shows. */
export function recordWaveCacheOutcome(outcome: CacheOutcome): void {
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
                { Name: 'CacheBypass', Unit: 'Count' }
              ]
            }
          ]
        },
        Environment: metricEnvironment(),
        Route: ROUTE_LABEL,
        CacheHit: outcome === 'hit' ? 1 : 0,
        CacheMiss: outcome === 'miss' ? 1 : 0,
        CacheBypass: outcome === 'bypass' ? 1 : 0
      })}\n`
    );
  } catch {
    logger.warn('Wave response cache telemetry could not be emitted');
  }
}

/** Mount after `maybeAuthenticatedUser()`, which sets `req.user`. */
export function anonymousWaveResponseCache() {
  const cache = cacheRequest(anonymousWaveResponseCacheOptions);
  return function anonymousWaveResponseCacheMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    if (carriesIdentity(req)) {
      res.once('finish', () => recordWaveCacheOutcome('bypass'));
      next();
      return;
    }
    // cacheRequest marks every response it handles X-Cache: HIT or MISS.
    res.once('finish', () =>
      recordWaveCacheOutcome(
        res.getHeader('X-Cache') === 'HIT' ? 'hit' : 'miss'
      )
    );
    return cache(req, res, next);
  };
}

/**
 * Drops the shared anonymous body of a wave after it is updated or deleted,
 * so anonymous readers see the change at once instead of up to 15 s later.
 * Only the plain URL is evicted (what clients request); a query-string
 * variant still expires by TTL. Never fails the write.
 */
export async function invalidateAnonymousWaveResponse(
  waveId: string
): Promise<void> {
  try {
    await evictKeyFromRedisCache(anonymousWaveCacheKey(`/api/waves/${waveId}`));
  } catch (error) {
    logger.warn('Failed to evict the anonymous wave response', error);
  }
}
