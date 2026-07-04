import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { compareCacheStrings, stableCacheHash } from './wave-cache-key';

export interface CachedFollowedSubwaveOverviewContext {
  readonly followed_subwaves_count: number;
  readonly latest_followed_subwave_activity_timestamp: number | null;
}

const logger = Logger.get('WAVE_FOLLOWED_SUBWAVE_OVERVIEW_CACHE');
const CACHE_TTL = Time.seconds(30);
const CACHE_KEY_PREFIX = 'cache_6529_wave_followed_subwave_overview_v1';
const inFlightReads = new Map<
  string,
  Promise<Record<string, CachedFollowedSubwaveOverviewContext>>
>();
const inFlightUnreadReads = new Map<string, Promise<unknown>>();

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
    Record<string, CachedFollowedSubwaveOverviewContext>
  >;
}): Promise<Record<string, CachedFollowedSubwaveOverviewContext>> {
  if (!cacheable || !parentWaveIds.length) {
    return await getValue();
  }

  const cacheKey = getCacheKey({ identityId, parentWaveIds, eligibleGroups });
  const cached = await readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = inFlightReads.get(cacheKey);
  if (existing !== undefined) {
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

export async function withInFlightFollowedSubwaveUnreadRead<T>({
  identityId,
  parentWaveIds,
  eligibleGroups,
  getValue
}: {
  readonly identityId: string;
  readonly parentWaveIds: string[];
  readonly eligibleGroups: string[];
  readonly getValue: () => Promise<T>;
}): Promise<T> {
  if (!parentWaveIds.length) {
    return await getValue();
  }

  const cacheKey = `${CACHE_KEY_PREFIX}:unread:${stableCacheHash({
    identityId,
    parentWaveIds: distinctSorted(parentWaveIds),
    eligibleGroups: distinctSorted(eligibleGroups)
  })}`;
  const existing = inFlightUnreadReads.get(cacheKey);
  if (existing !== undefined) {
    return (await existing) as T;
  }

  const promise = getValue();
  inFlightUnreadReads.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightUnreadReads.get(cacheKey) === promise) {
      inFlightUnreadReads.delete(cacheKey);
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
  return Array.from(new Set(values)).sort(compareCacheStrings);
}

async function readCache(
  cacheKey: string
): Promise<Record<string, CachedFollowedSubwaveOverviewContext> | null> {
  try {
    return await redisGet<Record<string, CachedFollowedSubwaveOverviewContext>>(
      cacheKey
    );
  } catch (error) {
    logger.warn('Failed to read followed subwave overview cache', error);
    return null;
  }
}

async function writeCache(
  cacheKey: string,
  value: Record<string, CachedFollowedSubwaveOverviewContext>
): Promise<void> {
  try {
    await redisSetJson(cacheKey, value, CACHE_TTL);
  } catch (error) {
    logger.warn('Failed to write followed subwave overview cache', error);
  }
}
