import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { nftLinkUpdatedMessage } from '@/api/ws/ws-message';
import { Logger } from '@/logging';
import { Time } from '@/time';

/**
 * A successful refresh always moves `last_successfully_updated`, so comparing
 * whole frames would never skip one. Clients use that timestamp only to call
 * a link stale (after 3 days), so it counts as a change once the previous
 * success is unknown or older than this.
 */
export const MEDIA_LINK_FRESHNESS_RESEND_MS = Time.hours(24).toMillis();

export type MediaLinkUpdateDecision = 'changed' | 'freshness' | 'unchanged';

const logger = Logger.get('NFT_LINK_UPDATE_CHANGE');

/** The MEDIA_LINK_UPDATED frame exactly as clients receive it, minus the refresh time. */
function clientFrameWithoutRefreshTime(data: ApiNftLinkData): string {
  return JSON.stringify(
    nftLinkUpdatedMessage({ ...data, last_successfully_updated: null })
  );
}

/**
 * Whether a refresh changed what clients see. `previous` is the link as it
 * was before the refresh, `next` as it is after; both go through the same
 * API mapping as the broadcast frame.
 */
export function mediaLinkUpdateDecision(
  previous: ApiNftLinkData,
  next: ApiNftLinkData,
  now: number
): MediaLinkUpdateDecision {
  if (
    clientFrameWithoutRefreshTime(previous) !==
    clientFrameWithoutRefreshTime(next)
  ) {
    return 'changed';
  }
  const previousSuccess = Number(previous.last_successfully_updated ?? NaN);
  if (
    !Number.isFinite(previousSuccess) ||
    now - previousSuccess >= MEDIA_LINK_FRESHNESS_RESEND_MS
  ) {
    return 'freshness';
  }
  return 'unchanged';
}

/** EMF counters: `MediaLinkUpdateSent` and `MediaLinkUpdateSkipped` per refresh. */
export function recordMediaLinkUpdateDecision(
  decision: MediaLinkUpdateDecision
): void {
  const sent = decision === 'unchanged' ? 0 : 1;
  try {
    process.stdout.write(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/NftLinkRefresher',
              Dimensions: [['Environment']],
              Metrics: [
                { Name: 'MediaLinkUpdateSent', Unit: 'Count' },
                { Name: 'MediaLinkUpdateSkipped', Unit: 'Count' }
              ]
            }
          ]
        },
        event: 'MEDIA_LINK_UPDATE_DECISION',
        Environment: process.env.OPS_ENVIRONMENT ?? 'unknown',
        decision,
        MediaLinkUpdateSent: sent,
        MediaLinkUpdateSkipped: 1 - sent
      }) + '\n'
    );
  } catch {
    // Telemetry must not change whether or what is sent.
    logger.warn('MEDIA_LINK_UPDATED decision telemetry could not be emitted');
  }
}
