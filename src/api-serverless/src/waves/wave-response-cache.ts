import type { NextFunction, Request, Response } from 'express';
import { Time } from '@/time';
import { cacheKey } from '@/api/api-helpers';
import { cacheRequest, type RequestCacheOptions } from '@/api/request-cache';
import type { ApiWave } from '@/api/generated/models/ApiWave';
import { Logger } from '@/logging';

/**
 * How long an anonymous `GET /waves/:id` response is shared. Anonymous
 * viewers see a public wave's metadata, metrics and description drop up to
 * this much late, and a wave that turns private stays visible to them for at
 * most this long.
 */
export const ANONYMOUS_WAVE_RESPONSE_TTL = Time.seconds(15);

const SHAREABLE = 'shareableAnonymousWave';
const logger = Logger.get('WAVE_RESPONSE_CACHE');

/** Any request signal that could identify the viewer. */
export function carriesIdentity(req: Request): boolean {
  if (req.user) return true;
  if (req.headers.authorization) return true;
  const cookies = req.headers.cookie ?? '';
  return /(?:^|;\s*)(?:__Host-wallet-auth|wallet-auth)[^=]*=/i.test(cookies);
}

const isSet = (value: unknown) =>
  value !== undefined && value !== null && value !== 0 && value !== false;

/**
 * True when the response holds state that belongs to one viewer: their
 * subscriptions, pin, counts, read position, mute, rep contribution or
 * their own context on the description drop. An anonymous response has
 * none of these.
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
 * bypass the cache entirely (no read, no fill) in the middleware below. Only 200 responses that the
 * handler marked shareable are stored, so a 304, an error or a viewer's
 * response is never replayed. Express still answers a matching
 * `If-None-Match` with 304 from the cached body. The key is the full URL
 * (path and query); no request header changes this route's body.
 */
export const anonymousWaveResponseCacheOptions: RequestCacheOptions = {
  ttl: ANONYMOUS_WAVE_RESPONSE_TTL,
  // Identity-bearing requests never reach the cache (see the middleware),
  // because cacheRequest falls back to the plain URL key for a null key.
  key: (req: Request) => `${cacheKey(req)}__ANON_WAVE`,
  shouldCacheResponse: (_req, res) =>
    res.statusCode === 200 && res.locals[SHAREABLE] === true
};

type CacheOutcome = 'hit' | 'miss' | 'bypass';

function deliveryEnvironment(): string {
  return (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
}

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
        Environment: deliveryEnvironment(),
        Route: 'GET /waves/:id',
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
    res.once('finish', () =>
      recordWaveCacheOutcome(
        res.getHeader('X-Cache') === 'HIT' ? 'hit' : 'miss'
      )
    );
    return cache(req, res, next);
  };
}
