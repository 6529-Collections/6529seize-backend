import { ApiWaveOverviewPage } from '@/api/generated/models/ApiWaveOverviewPage';
import type { FindWavesV2Request } from '@/api/waves/api-wave-v2.service';
import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { stableCacheHash } from './wave-cache-key';

const logger = Logger.get('WAVE_OVERVIEW_RESPONSE_CACHE');
const CACHE_TTL = Time.seconds(10);
const CACHE_KEY_PREFIX = 'cache_6529_api_v2_waves_response_v1';
const inFlightResponseReads = new Map<string, Promise<ApiWaveOverviewPage>>();

export async function withWaveOverviewResponseCache({
  contextProfileId,
  eligibleGroups,
  request,
  getValue
}: {
  readonly contextProfileId: string | null;
  readonly eligibleGroups: string[];
  readonly request: FindWavesV2Request;
  readonly getValue: () => Promise<ApiWaveOverviewPage>;
}): Promise<ApiWaveOverviewPage> {
  const cacheKey = getResponseCacheKey({
    contextProfileId,
    eligibleGroups,
    request
  });
  const cached = await readResponseCache(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = inFlightResponseReads.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const promise = (async () => {
    const value = await getValue();
    await writeResponseCache(cacheKey, value);
    return value;
  })();
  inFlightResponseReads.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightResponseReads.get(cacheKey) === promise) {
      inFlightResponseReads.delete(cacheKey);
    }
  }
}

function getResponseCacheKey({
  contextProfileId,
  eligibleGroups,
  request
}: {
  readonly contextProfileId: string | null;
  readonly eligibleGroups: string[];
  readonly request: FindWavesV2Request;
}): string {
  return `${CACHE_KEY_PREFIX}:${stableCacheHash({
    contextProfileId: contextProfileId ?? 'anonymous',
    eligibleGroups: Array.from(new Set(eligibleGroups)).sort(),
    request
  })}`;
}

async function readResponseCache(
  cacheKey: string
): Promise<ApiWaveOverviewPage | null> {
  try {
    return await redisGet<ApiWaveOverviewPage>(cacheKey);
  } catch (error) {
    logger.warn('Failed to read wave overview response cache', error);
    return null;
  }
}

async function writeResponseCache(
  cacheKey: string,
  value: ApiWaveOverviewPage
): Promise<void> {
  try {
    await redisSetJson(cacheKey, value, CACHE_TTL);
  } catch (error) {
    logger.warn('Failed to write wave overview response cache', error);
  }
}
