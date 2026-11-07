import { isQueryTimeout } from '@/db/query-timeout';
import { DropLogsQueryParams } from '@/drops/drops.db';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';

export const WAVE_LOGS_TIMEOUT_CODE = 'WAVE_LOGS_TIMEOUT';
/** How long a whole-wave log read that ran out of budget is not retried. */
export const WAVE_LOGS_TIMEOUT_TTL = Time.seconds(60);

const logger = Logger.get('WAVE_LOGS_TIMEOUT');

export class WaveLogsUnavailableException extends CustomApiCompliantException {
  constructor() {
    super(
      503,
      'Wave activity is taking too long to load. Try again in a minute.',
      WAVE_LOGS_TIMEOUT_CODE,
      { retry_after_seconds: WAVE_LOGS_TIMEOUT_TTL.toSeconds() }
    );
  }
}

/** One request shape: wave, sort, page and types (in any order). */
function timeoutKey(param: DropLogsQueryParams): string {
  const types = [...param.log_types].sort((a, b) => a.localeCompare(b));
  return [
    'wave-logs-timeout',
    encodeURIComponent(param.wave_id),
    param.sort_direction,
    param.offset,
    param.limit,
    types.join(',')
  ].join(':');
}

/** The memo is best-effort: Redis trouble never changes the response. */
async function rememberedTimeout(key: string): Promise<boolean> {
  try {
    return (await redisGet<boolean>(key)) === true;
  } catch (error) {
    logger.warn('[WAVE_LOGS_TIMEOUT_MEMO_UNAVAILABLE]', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function rememberTimeout(key: string): Promise<void> {
  try {
    await redisSetJson(key, true, WAVE_LOGS_TIMEOUT_TTL);
  } catch (error) {
    logger.warn('[WAVE_LOGS_TIMEOUT_MEMO_UNAVAILABLE]', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Runs a whole-wave log read (no drop id). When it runs out of its database
 * budget, the same request is answered with a 503 for a minute without
 * querying again, so client retries and refetches can't pile up slow scans.
 * Drop-scoped reads are indexed and run unguarded.
 */
export async function withWaveLogsTimeoutGuard<T>(
  param: DropLogsQueryParams,
  read: () => Promise<T>
): Promise<T> {
  if (param.drop_id) return read();
  const key = timeoutKey(param);
  if (await rememberedTimeout(key)) throw new WaveLogsUnavailableException();
  try {
    return await read();
  } catch (error) {
    if (!isQueryTimeout(error)) throw error;
    logger.warn('[WAVE_LOGS_TIMEOUT]', { wave_id: param.wave_id });
    await rememberTimeout(key);
    throw new WaveLogsUnavailableException();
  }
}
