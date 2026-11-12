import { createHmac } from 'node:crypto';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { getJwtSecret } from '@/api/auth/auth';

// Failed connection-share redeems are counted per source address. Share
// codes are 256-bit, so this only caps noise: after
// CONNECTION_SHARE_REDEEM_FAILURE_LIMIT failures within the window the source
// gets 429 until the window ends. Counters live in Redis under a keyed hash of
// the address (never the address itself) and expire with the window. Without
// Redis the limiter is off (fails open), like the API rate limiter.

export const CONNECTION_SHARE_REDEEM_FAILURE_LIMIT = 20;
export const CONNECTION_SHARE_REDEEM_FAILURE_WINDOW_SECONDS = 10 * 60;

const NAMESPACE = '6529/Auth';
const KEY_PREFIX = 'auth_connection_share_redeem_failures';
const logger = Logger.get('CONNECTION_SHARE_REDEEM_GUARD');

export type ConnectionShareRedeemOutcome = 'ok' | 'refused' | 'limited';

function failureKey(sourceIp: string): string {
  const sourceHash = createHmac('sha256', getJwtSecret())
    .update(`connection-share-redeem\0${sourceIp}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${KEY_PREFIX}:${sourceHash}`;
}

/** Whether this source has reached the failed-redeem limit. Never throws. */
export async function isConnectionShareRedeemLimited(
  sourceIp: string
): Promise<boolean> {
  const redis = getRedisClient();
  if (!sourceIp || !redis) {
    return false;
  }
  try {
    const failures = Number((await redis.get(failureKey(sourceIp))) ?? 0);
    return failures >= CONNECTION_SHARE_REDEEM_FAILURE_LIMIT;
  } catch (error) {
    logger.warn('Connection share redeem limit check failed', error);
    return false;
  }
}

/**
 * Counts one failed redeem for this source. The first failure starts the
 * window; the counter and its expiry are written atomically. Never throws.
 */
export async function recordFailedConnectionShareRedeem(
  sourceIp: string
): Promise<void> {
  const redis = getRedisClient();
  if (!sourceIp || !redis) {
    return;
  }
  const key = failureKey(sourceIp);
  try {
    await redis
      .multi()
      .set(key, '0', {
        NX: true,
        EX: CONNECTION_SHARE_REDEEM_FAILURE_WINDOW_SECONDS
      })
      .incr(key)
      .exec();
  } catch (error) {
    logger.warn('Connection share redeem failure could not be counted', error);
  }
}

/**
 * One redeem attempt as an EMF metric, by target, outcome and whether device
 * setup was returned. Never records codes, addresses or sessions.
 */
export function recordConnectionShareRedeem(record: {
  readonly target: string;
  readonly outcome: ConnectionShareRedeemOutcome;
  readonly withDeviceSetup: boolean;
}): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.connection_share_redeem.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [['Target', 'Outcome', 'DeviceSetup']],
              Metrics: [{ Name: 'ConnectionShareRedeems', Unit: 'Count' }]
            }
          ]
        },
        Target: record.target,
        Outcome: record.outcome,
        DeviceSetup: record.withDeviceSetup ? 'yes' : 'no',
        ConnectionShareRedeems: 1
      })}\n`
    );
  } catch {
    // Telemetry must never change a request.
  }
}
