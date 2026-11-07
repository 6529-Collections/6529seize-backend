import { afterCommit } from '@/db/after-commit';
import { DropMediaEntity, DropPartEntity } from '@/entities/IDrop';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { WaveEntity } from '@/entities/IWave';
import { Logger } from '@/logging';
import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import type { ConnectionWrapper } from '@/sql-executor';
import { Time } from '@/time';
import { compareCacheStrings, stableCacheHash } from './wave-cache-key';
import { recordWaveCacheLookup } from './wave-cache-metrics';
import {
  areCacheVersionsSettled,
  bumpCacheVersion,
  readCacheVersions
} from './wave-cache-version';

/**
 * The viewer-neutral part of a wave overview: its description drop's first
 * part and that part's media. Nothing here may depend on who is asking (the
 * creator profile, for example, carries the viewer's subscriptions and is
 * loaded per request).
 */
export interface WaveOverviewStaticCacheEntry {
  readonly descriptionDropPartOne: DropPartEntity | null;
  readonly descriptionDropPartOneMedia: DropMediaEntity[];
}

export interface WaveOverviewStaticCacheReadResult {
  readonly cachedByWaveId: Record<string, WaveOverviewStaticCacheEntry>;
  readonly uncachedWaveIds: string[];
  /** Keys the loaded entries may be stored under. */
  readonly cacheKeysByWaveId: Record<string, string>;
  /** Every wave's versioned key, stored or not, for coalescing misses. */
  readonly versionedKeysByWaveId: Record<string, string>;
}

const logger = Logger.get('WAVE_OVERVIEW_STATIC_CACHE');
export const WAVE_OVERVIEW_STATIC_CACHE_TTL = Time.seconds(30);
// v2: viewer-neutral entries (no creator) keyed on the description drop's
// content version.
const CACHE_KEY_PREFIX = 'cache_6529_wave_overview_static_v2';
const DROP_CONTENT_VERSION_KEY_PREFIX = 'cache_6529_drop_content_version_v1';
export const DROP_CONTENT_VERSION_TTL = Time.days(1);
/** Media still being uploaded or processed changes without a drop write. */
const SETTLED_MEDIA_STATUSES: ReadonlySet<DropMediaUploadStatus> = new Set([
  DropMediaUploadStatus.READY,
  DropMediaUploadStatus.FAILED
]);
const inFlightReads = new Map<
  string,
  Promise<Record<string, WaveOverviewStaticCacheEntry>>
>();

function dropContentVersionKey(dropId: string): string {
  return `${DROP_CONTENT_VERSION_KEY_PREFIX}:${dropId}`;
}

function uncachedResult(
  waves: WaveEntity[],
  versionedKeysByWaveId: Record<string, string> = {}
): WaveOverviewStaticCacheReadResult {
  return {
    cachedByWaveId: {},
    uncachedWaveIds: waves.map((wave) => wave.id),
    cacheKeysByWaveId: {},
    versionedKeysByWaveId
  };
}

export async function readWaveOverviewStaticCache(
  waves: WaveEntity[],
  cacheable = true
): Promise<WaveOverviewStaticCacheReadResult> {
  const uniqueWaves = distinctWaves(waves);
  if (!cacheable || !uniqueWaves.length || !getRedisClient()) {
    return uncachedResult(uniqueWaves);
  }

  let versions: string[] | null;
  try {
    versions = await readCacheVersions(
      uniqueWaves.map((wave) => dropContentVersionKey(wave.description_drop_id))
    );
  } catch (error) {
    logger.warn('Failed to read wave overview static cache versions', error);
    versions = null;
  }
  if (!versions) {
    recordWaveCacheLookup('wave_overview_static', {
      error: uniqueWaves.length
    });
    return uncachedResult(uniqueWaves);
  }
  const now = Date.now();
  const versionedKeysByWaveId: Record<string, string> = {};
  const cacheKeysByWaveId: Record<string, string> = {};
  uniqueWaves.forEach((wave, index) => {
    const version = versions[index];
    const key = `${CACHE_KEY_PREFIX}:${wave.id}:${stableCacheHash({
      descriptionDropId: wave.description_drop_id,
      updatedAt: normalizeUpdatedAt(wave.updated_at)
    })}:${version}`;
    versionedKeysByWaveId[wave.id] = key;
    if (areCacheVersionsSettled([version], now)) {
      cacheKeysByWaveId[wave.id] = key;
    }
  });

  let cachedByKey: Record<string, WaveOverviewStaticCacheEntry>;
  try {
    cachedByKey = await redisGetMany<WaveOverviewStaticCacheEntry>(
      Object.values(cacheKeysByWaveId)
    );
  } catch (error) {
    logger.warn('Failed to read wave overview static cache', error);
    recordWaveCacheLookup('wave_overview_static', {
      error: uniqueWaves.length
    });
    return uncachedResult(uniqueWaves, versionedKeysByWaveId);
  }
  const cachedByWaveId: Record<string, WaveOverviewStaticCacheEntry> = {};
  for (const wave of uniqueWaves) {
    const key = cacheKeysByWaveId[wave.id];
    const cached = key === undefined ? undefined : cachedByKey[key];
    if (cached) {
      cachedByWaveId[wave.id] = cached;
    }
  }
  const hit = Object.keys(cachedByWaveId).length;
  const settling = uniqueWaves.length - Object.keys(cacheKeysByWaveId).length;
  recordWaveCacheLookup('wave_overview_static', {
    hit,
    miss: uniqueWaves.length - hit - settling,
    settling
  });
  return {
    cachedByWaveId,
    uncachedWaveIds: uniqueWaves
      .map((wave) => wave.id)
      .filter((waveId) => !cachedByWaveId[waveId]),
    cacheKeysByWaveId,
    versionedKeysByWaveId
  };
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
        if (cacheKey && hasSettledMedia(entry)) {
          await redisSetJson(
            cacheKey,
            viewerNeutral(entry),
            WAVE_OVERVIEW_STATIC_CACHE_TTL
          );
        }
      })
    );
  } catch (error) {
    logger.warn('Failed to write wave overview static cache', error);
  }
}

export async function withInFlightWaveOverviewStaticCacheRead({
  versionedKeysByWaveId,
  waveIds,
  getValue
}: {
  readonly versionedKeysByWaveId: Record<string, string>;
  readonly waveIds: string[];
  readonly getValue: () => Promise<
    Record<string, WaveOverviewStaticCacheEntry>
  >;
}): Promise<Record<string, WaveOverviewStaticCacheEntry>> {
  if (!waveIds.length) {
    return {};
  }

  const inFlightKey = waveIds
    .map((waveId) => versionedKeysByWaveId[waveId] ?? waveId)
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

/**
 * Retires cached overviews built on these drops' content. Description drops
 * are edited by delete + insert, so drop deletions and in-place part
 * rewrites call this. Fails open (logged): the 30 s TTL bounds a lost bump.
 */
export async function invalidateWaveOverviewStaticCacheForDrops(
  dropIds: string[]
): Promise<void> {
  await Promise.all(
    Array.from(new Set(dropIds)).map(async (dropId) => {
      try {
        await bumpCacheVersion(
          dropContentVersionKey(dropId),
          DROP_CONTENT_VERSION_TTL
        );
      } catch (error) {
        logger.warn('Failed to invalidate wave overview static cache', {
          dropId,
          error
        });
      }
    })
  );
}

/** Waits for COMMIT inside a transaction; see after-commit.ts. */
export async function invalidateWaveOverviewStaticCacheForDropsAfterCommit(
  dropIds: string[],
  connection: ConnectionWrapper<any> | undefined
): Promise<void> {
  await Promise.all(
    Array.from(new Set(dropIds)).map((dropId) =>
      afterCommit(
        connection,
        () => invalidateWaveOverviewStaticCacheForDrops([dropId]),
        `wave-overview-static:drop:${dropId}`
      )
    )
  );
}

function hasSettledMedia(entry: WaveOverviewStaticCacheEntry): boolean {
  // No status means no upload row: plain media is always settled.
  return entry.descriptionDropPartOneMedia.every(
    (media) =>
      !media.media_status || SETTLED_MEDIA_STATUSES.has(media.media_status)
  );
}

/** Stores only the declared fields, whatever the loader attached. */
function viewerNeutral(
  entry: WaveOverviewStaticCacheEntry
): WaveOverviewStaticCacheEntry {
  return {
    descriptionDropPartOne: entry.descriptionDropPartOne,
    descriptionDropPartOneMedia: entry.descriptionDropPartOneMedia
  };
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
