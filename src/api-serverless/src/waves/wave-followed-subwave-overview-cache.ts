import type { FollowedSubwaveOverviewContext } from '@/api/waves/waves.api.db';
import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { stableCacheHash } from './wave-cache-key';

const logger = Logger.get('WAVE_FOLLOWED_SUBWAVE_OVERVIEW_CACHE');
const CACHE_TTL = Time.seconds(30);
const CACHE_KEY_PREFIX = 'cache_6529_wave_followed_subwave_overview_v1';
const inFlightReads = new Map<
  string,
  Promise<Record<string, FollowedSubwaveOverviewContext>>
>();

export async function withFollowedSubwaveOverviewContextCache({
  identityId,
  parentWaveIds,
  eligibleGroups,
  cacheable,
  getValue
}: {
  readonly identityId: string;
  readonly parentWaveIds: string[];
  readonly eligibleGroups: string[];
  readonly cacheable: boolean;
  readonly getValue: () => Promise<
    Record<string, FollowedSubwaveOverviewContext>
  >;
}): Promise<Record<string, FollowedSubwaveOverviewContext>> {
  if (!cacheable || !parentWaveIds.length) {
    return await getValue();
  }

  const cacheKey = getCacheKey({ identityId, parentWaveIds, eligibleGroups });
  const cached = await readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = inFlightReads.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const promise = (async () => {
    const value = await getValue();
    await writeCache(cacheKey, value);
    return value;
  })();
  inFlightReads.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightReads.get(cacheKey) === promise) {
      inFlightReads.delete(cacheKey);
    }
  }
}

function getCacheKey({
  identityId,
  parentWaveIds,
  eligibleGroups
}: {
  readonly identityId: string;
  readonly parentWaveIds: string[];
  readonly eligibleGroups: string[];
}): string {
  return `${CACHE_KEY_PREFIX}:${stableCacheHash({
    identityId,
    parentWaveIds: distinctSorted(parentWaveIds),
    eligibleGroups: distinctSorted(eligibleGroups)
  })}`;
}

function distinctSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

async function readCache(
  cacheKey: string
): Promise<Record<string, FollowedSubwaveOverviewContext> | null> {
  try {
    return await redisGet<Record<string, FollowedSubwaveOverviewContext>>(
      cacheKey
    );
  } catch (error) {
    logger.warn('Failed to read followed subwave overview cache', error);
    return null;
  }
}

async function writeCache(
  cacheKey: string,
  value: Record<string, FollowedSubwaveOverviewContext>
): Promise<void> {
  try {
    await redisSetJson(cacheKey, value, CACHE_TTL);
  } catch (error) {
    logger.warn('Failed to write followed subwave overview cache', error);
  }
}
