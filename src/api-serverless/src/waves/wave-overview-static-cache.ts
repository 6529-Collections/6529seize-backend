import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { DropMediaEntity, DropPartEntity } from '@/entities/IDrop';
import { WaveEntity } from '@/entities/IWave';
import { Logger } from '@/logging';
import { redisGetMany, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { compareCacheStrings, stableCacheHash } from './wave-cache-key';

export interface WaveOverviewStaticCacheEntry {
  readonly descriptionDropPartOne: DropPartEntity | null;
  readonly descriptionDropPartOneMedia: DropMediaEntity[];
  readonly creator: ApiProfileMin | null;
}

export interface WaveOverviewStaticCacheReadResult {
  readonly cachedByWaveId: Record<string, WaveOverviewStaticCacheEntry>;
  readonly uncachedWaveIds: string[];
  readonly cacheKeysByWaveId: Record<string, string>;
}

const logger = Logger.get('WAVE_OVERVIEW_STATIC_CACHE');
const CACHE_TTL = Time.seconds(30);
const CACHE_KEY_PREFIX = 'cache_6529_wave_overview_static_v1';
const inFlightReads = new Map<
  string,
  Promise<Record<string, WaveOverviewStaticCacheEntry>>
>();

export async function readWaveOverviewStaticCache(
  waves: WaveEntity[],
  cacheable = true
): Promise<WaveOverviewStaticCacheReadResult> {
  const uniqueWaves = distinctWaves(waves);
  const cacheKeysByWaveId = getCacheKeysByWaveId(uniqueWaves);
  if (!cacheable || !uniqueWaves.length) {
    return {
      cachedByWaveId: {},
      uncachedWaveIds: uniqueWaves.map((wave) => wave.id),
      cacheKeysByWaveId
    };
  }

  try {
    const cachedByKey = await redisGetMany<WaveOverviewStaticCacheEntry>(
      Object.values(cacheKeysByWaveId)
    );
    const cachedByWaveId = uniqueWaves.reduce(
      (acc, wave) => {
        const cached = cachedByKey[cacheKeysByWaveId[wave.id]];
        if (cached) {
          acc[wave.id] = cached;
        }
        return acc;
      },
      {} as Record<string, WaveOverviewStaticCacheEntry>
    );
    return {
      cachedByWaveId,
      uncachedWaveIds: uniqueWaves
        .map((wave) => wave.id)
        .filter((waveId) => !cachedByWaveId[waveId]),
      cacheKeysByWaveId
    };
  } catch (error) {
    logger.warn('Failed to read wave overview static cache', error);
    return {
      cachedByWaveId: {},
      uncachedWaveIds: uniqueWaves.map((wave) => wave.id),
      cacheKeysByWaveId
    };
  }
}

export async function writeWaveOverviewStaticCache({
  entriesByWaveId,
  cacheKeysByWaveId
}: {
  readonly entriesByWaveId: Record<string, WaveOverviewStaticCacheEntry>;
  readonly cacheKeysByWaveId: Record<string, string>;
}): Promise<void> {
  try {
    await Promise.all(
      Object.entries(entriesByWaveId).map(async ([waveId, entry]) => {
        const cacheKey = cacheKeysByWaveId[waveId];
        if (cacheKey) {
          await redisSetJson(cacheKey, entry, CACHE_TTL);
        }
      })
    );
  } catch (error) {
    logger.warn('Failed to write wave overview static cache', error);
  }
}

export async function withInFlightWaveOverviewStaticCacheRead({
  cacheKeysByWaveId,
  waveIds,
  getValue
}: {
  readonly cacheKeysByWaveId: Record<string, string>;
  readonly waveIds: string[];
  readonly getValue: () => Promise<
    Record<string, WaveOverviewStaticCacheEntry>
  >;
}): Promise<Record<string, WaveOverviewStaticCacheEntry>> {
  if (!waveIds.length) {
    return {};
  }

  const inFlightKey = waveIds
    .map((waveId) => cacheKeysByWaveId[waveId] ?? waveId)
    .sort(compareCacheStrings)
    .join('|');
  const existing = inFlightReads.get(inFlightKey);
  if (existing !== undefined) {
    return await existing;
  }

  const promise = getValue();
  inFlightReads.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightReads.get(inFlightKey) === promise) {
      inFlightReads.delete(inFlightKey);
    }
  }
}

function getCacheKeysByWaveId(waves: WaveEntity[]): Record<string, string> {
  return waves.reduce(
    (acc, wave) => {
      acc[wave.id] = `${CACHE_KEY_PREFIX}:${wave.id}:${stableCacheHash({
        createdBy: wave.created_by,
        descriptionDropId: wave.description_drop_id,
        updatedAt: normalizeUpdatedAt(wave.updated_at)
      })}`;
      return acc;
    },
    {} as Record<string, string>
  );
}

function normalizeUpdatedAt(updatedAt: unknown): number | string | null {
  if (updatedAt instanceof Date) {
    return updatedAt.getTime();
  }
  return (updatedAt as number | string | null) ?? null;
}

function distinctWaves(waves: WaveEntity[]): WaveEntity[] {
  const seen = new Set<string>();
  return waves.filter((wave) => {
    if (seen.has(wave.id)) {
      return false;
    }
    seen.add(wave.id);
    return true;
  });
}
