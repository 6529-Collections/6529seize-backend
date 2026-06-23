import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import { Logger } from '@/logging';
import { Time } from '@/time';

export interface WaveUnreadSummary {
  readonly unread_drops_count: number;
  readonly first_unread_drop_serial_no: number | null;
}

export interface WaveUnreadSummaryCacheReadResult {
  readonly cachedByWaveId: Record<string, WaveUnreadSummary>;
  readonly uncachedWaveIds: string[];
  readonly cacheKeysByWaveId: Record<string, string>;
}

export interface WaveUnreadReaderWave {
  readonly identityId: string;
  readonly waveId: string;
}

export interface WaveUnreadCacheInvalidations {
  readonly waveIds: string[];
  readonly readerWaves: WaveUnreadReaderWave[];
}

const logger = Logger.get('WAVE_UNREAD_CACHE');
const CACHE_TTL = Time.seconds(30);
const CACHE_KEY_PREFIX = 'cache_6529_wave_unread_summary_v1';
const WAVE_VERSION_KEY_PREFIX = 'cache_6529_wave_unread_wave_version_v1';
const READER_VERSION_KEY_PREFIX = 'cache_6529_wave_unread_reader_version_v1';

function distinct(values: string[]): string[] {
  return Array.from(new Set(values));
}

function waveVersionKey(waveId: string): string {
  return `${WAVE_VERSION_KEY_PREFIX}:${waveId}`;
}

function readerVersionKey(identityId: string, waveId: string): string {
  return `${READER_VERSION_KEY_PREFIX}:${identityId}:${waveId}`;
}

function summaryCacheKey({
  identityId,
  waveId,
  waveVersion,
  readerVersion
}: {
  identityId: string;
  waveId: string;
  waveVersion: string;
  readerVersion: string;
}): string {
  return `${CACHE_KEY_PREFIX}:${identityId}:${waveId}:${waveVersion}:${readerVersion}`;
}

async function getVersions(keys: string[]): Promise<Record<string, string>> {
  const redis = getRedisClient();
  if (!redis || keys.length === 0) {
    return {};
  }
  try {
    const values = await redis.mGet(keys);
    return keys.reduce(
      (acc, key, index) => {
        acc[key] = values[index] ?? '0';
        return acc;
      },
      {} as Record<string, string>
    );
  } catch (error) {
    logger.warn('Failed to read wave unread cache versions', error);
    return {};
  }
}

async function getCacheKeysByWaveId(
  identityId: string,
  waveIds: string[]
): Promise<Record<string, string>> {
  const uniqueWaveIds = distinct(waveIds);
  const waveVersionKeys = uniqueWaveIds.map(waveVersionKey);
  const readerVersionKeys = uniqueWaveIds.map((waveId) =>
    readerVersionKey(identityId, waveId)
  );
  const [waveVersionsByKey, readerVersionsByKey] = await Promise.all([
    getVersions(waveVersionKeys),
    getVersions(readerVersionKeys)
  ]);
  return uniqueWaveIds.reduce(
    (acc, waveId) => {
      acc[waveId] = summaryCacheKey({
        identityId,
        waveId,
        waveVersion: waveVersionsByKey[waveVersionKey(waveId)] ?? '0',
        readerVersion:
          readerVersionsByKey[readerVersionKey(identityId, waveId)] ?? '0'
      });
      return acc;
    },
    {} as Record<string, string>
  );
}

export async function readWaveUnreadSummaryCache(
  identityId: string,
  waveIds: string[]
): Promise<WaveUnreadSummaryCacheReadResult> {
  const uniqueWaveIds = distinct(waveIds);
  if (uniqueWaveIds.length === 0 || !getRedisClient()) {
    return {
      cachedByWaveId: {},
      uncachedWaveIds: uniqueWaveIds,
      cacheKeysByWaveId: {}
    };
  }
  try {
    const cacheKeysByWaveId = await getCacheKeysByWaveId(
      identityId,
      uniqueWaveIds
    );
    const cachedByKey = await redisGetMany<WaveUnreadSummary>(
      Object.values(cacheKeysByWaveId)
    );
    const cachedByWaveId = uniqueWaveIds.reduce(
      (acc, waveId) => {
        const cached = cachedByKey[cacheKeysByWaveId[waveId]];
        if (cached) {
          acc[waveId] = cached;
        }
        return acc;
      },
      {} as Record<string, WaveUnreadSummary>
    );
    return {
      cachedByWaveId,
      uncachedWaveIds: uniqueWaveIds.filter(
        (waveId) => !cachedByWaveId[waveId]
      ),
      cacheKeysByWaveId
    };
  } catch (error) {
    logger.warn('Failed to read wave unread summary cache', error);
    return {
      cachedByWaveId: {},
      uncachedWaveIds: uniqueWaveIds,
      cacheKeysByWaveId: {}
    };
  }
}

export async function writeWaveUnreadSummaryCache({
  summariesByWaveId,
  cacheKeysByWaveId
}: {
  summariesByWaveId: Record<string, WaveUnreadSummary>;
  cacheKeysByWaveId: Record<string, string>;
}): Promise<void> {
  try {
    await Promise.all(
      Object.entries(summariesByWaveId).map(async ([waveId, summary]) => {
        const cacheKey = cacheKeysByWaveId[waveId];
        if (cacheKey) {
          await redisSetJson(cacheKey, summary, CACHE_TTL);
        }
      })
    );
  } catch (error) {
    logger.warn('Failed to write wave unread summary cache', error);
  }
}

export async function invalidateWaveUnreadCacheForWave(
  waveId: string
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    await redis.incr(waveVersionKey(waveId));
  } catch (error) {
    logger.warn('Failed to invalidate wave unread cache for wave', {
      waveId,
      error
    });
  }
}

export async function invalidateWaveUnreadCacheForWaves(
  waveIds: string[]
): Promise<void> {
  await Promise.allSettled(
    distinct(waveIds).map(invalidateWaveUnreadCacheForWave)
  );
}

export async function invalidateWaveUnreadCacheForReaderWave({
  identityId,
  waveId
}: {
  identityId: string;
  waveId: string;
}): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    await redis.incr(readerVersionKey(identityId, waveId));
  } catch (error) {
    logger.warn('Failed to invalidate wave unread cache for reader wave', {
      identityId,
      waveId,
      error
    });
  }
}

export async function invalidateWaveUnreadCacheForReaderWaves(
  readerWaves: WaveUnreadReaderWave[]
): Promise<void> {
  const seen = new Set<string>();
  const uniqueReaderWaves = readerWaves.filter(({ identityId, waveId }) => {
    const key = `${identityId}:${waveId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  await Promise.allSettled(
    uniqueReaderWaves.map(invalidateWaveUnreadCacheForReaderWave)
  );
}

export async function invalidateWaveUnreadCache({
  waveIds,
  readerWaves
}: WaveUnreadCacheInvalidations): Promise<void> {
  await Promise.all([
    invalidateWaveUnreadCacheForWaves(waveIds),
    invalidateWaveUnreadCacheForReaderWaves(readerWaves)
  ]);
}
