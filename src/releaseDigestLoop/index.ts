import { Logger } from '@/logging';
import {
  ReleaseDigestOutcome,
  ReleaseDigestRequest,
  releaseDigestService
} from '@/release-notes/release-digest.service';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';

const logger = Logger.get('RELEASE_DIGEST_LOOP');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toUtcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Scheduled runs digest everything deployed before the event time, keyed by
 * its UTC date, so EventBridge retries repeat the same digest. Manual runs
 * accept `digest_key` and `dry_run` (returns the text without posting).
 */
export function resolveReleaseDigestRequest(
  event: unknown,
  now = Date.now()
): ReleaseDigestRequest {
  const payload = isRecord(event) ? event : {};
  const scheduled =
    payload.source === 'aws.events' &&
    payload['detail-type'] === 'Scheduled Event';
  if (scheduled) {
    const time =
      typeof payload.time === 'string' ? Date.parse(payload.time) : Number.NaN;
    if (!Number.isFinite(time)) {
      throw new TypeError(
        'Scheduled release digest has an invalid event timestamp'
      );
    }
    return { digestKey: toUtcDate(time), cutoff: time, dryRun: false };
  }
  return {
    digestKey:
      typeof payload.digest_key === 'string'
        ? payload.digest_key
        : toUtcDate(now),
    cutoff: now,
    dryRun: payload.dry_run === true
  };
}

export async function runReleaseDigest(
  event: unknown
): Promise<ReleaseDigestOutcome | { readonly status: 'not-production' }> {
  // Release digest entries only exist in production.
  if (process.env.RELEASE_DIGEST_STAGE !== 'prod') {
    return { status: 'not-production' };
  }
  const request = resolveReleaseDigestRequest(event);
  return doInDbContext(() => releaseDigestService.publish(request, {}), {
    logger
  });
}

export const handler = sentryContext.wrapLambdaHandler(runReleaseDigest);
