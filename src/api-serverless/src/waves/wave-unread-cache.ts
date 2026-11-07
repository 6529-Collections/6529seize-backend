import { afterCommit } from '@/db/after-commit';
import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import type { ConnectionWrapper } from '@/sql-executor';
import { Logger } from '@/logging';
import { Time } from '@/time';
import { compareCacheStrings } from './wave-cache-key';
import { recordWaveCacheLookup } from './wave-cache-metrics';
import {
  areCacheVersionsSettled,
  bumpCacheVersion,
  readCacheVersions
} from './wave-cache-version';

export interface WaveUnreadSummary {
  readonly unread_drops_count: number;
  readonly first_unread_drop_serial_no: number | null;
}

export interface WaveUnreadSummaryCacheReadResult {
  readonly cachedByWaveId: Record<string, WaveUnreadSummary>;
  readonly uncachedWaveIds: string[];
  /** Keys the computed summaries may be stored under. */
  readonly cacheKeysByWaveId: Record<string, string>;
  /**
   * The versioned key of every wave whose versions could be read, stored or
   * not. Concurrent misses coalesce only on the same versions, so a read that
   * started before a change is never shared with one that started after it.
   */
  readonly versionedKeysByWaveId: Record<string, string>;
}

export interface WaveUnreadReaderWave {
  readonly identityId: string;
  readonly waveId: string;
}

export interface WaveUnreadCacheInvalidations {
  readonly waveIds: string[];
  readonly readerWaves: WaveUnreadReaderWave[];
}

export function distinctWaveUnreadReaderWaves(
  readerWaves: WaveUnreadReaderWave[]
): WaveUnreadReaderWave[] {
  const seen = new Set<string>();
  return readerWaves.filter(({ identityId, waveId }) => {
    const key = `${identityId}:${waveId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const logger = Logger.get('WAVE_UNREAD_CACHE');
const CACHE_TTL = Time.minutes(5);
// v2: versions are "<epoch ms>.<random>" strings written with SET, not INCR
// counters, and the reader-global version is part of every key.
const CACHE_KEY_PREFIX = 'cache_6529_wave_unread_summary_v2';
const WAVE_VERSION_KEY_PREFIX = 'cache_6529_wave_unread_wave_version_v2';
const READER_VERSION_KEY_PREFIX = 'cache_6529_wave_unread_reader_version_v2';
const READER_GLOBAL_VERSION_KEY_PREFIX =
  'cache_6529_wave_unread_reader_global_version_v2';
/** Version keys outlive every summary that can still be keyed on them. */
const VERSION_TTL = Time.days(7);
const inFlightSummaryMissReads = new Map<
  string,
  Promise<Record<string, WaveUnreadSummary>>
>();

function distinct(values: string[]): string[] {
  return Array.from(new Set(values));
}

function waveVersionKey(waveId: string): string {
  return `${WAVE_VERSION_KEY_PREFIX}:${waveId}`;
}

function readerVersionKey(identityId: string, waveId: string): string {
  return `${READER_VERSION_KEY_PREFIX}:${identityId}:${waveId}`;
}

function readerGlobalVersionKey(identityId: string): string {
  return `${READER_GLOBAL_VERSION_KEY_PREFIX}:${identityId}`;
}

function summaryCacheKey(
  identityId: string,
  waveId: string,
  versions: string[]
): string {
  return `${CACHE_KEY_PREFIX}:${identityId}:${waveId}:${versions.join(':')}`;
}

/**
 * Null when versions cannot be read: every wave is then uncached, never keyed
 * on a guessed version.
 */
async function getVersions(keys: string[]): Promise<string[] | null> {
  try {
    return await readCacheVersions(keys);
  } catch (error) {
    logger.warn('Failed to read wave unread cache versions', error);
    return null;
  }
}

async function getVersionedKeys(
  identityId: string,
  waveIds: string[]
): Promise<{
  versionedKeysByWaveId: Record<string, string>;
  cacheKeysByWaveId: Record<string, string>;
} | null> {
  const versions = await getVersions([
    readerGlobalVersionKey(identityId),
    ...waveIds.flatMap((waveId) => [
      waveVersionKey(waveId),
      readerVersionKey(identityId, waveId)
    ])
  ]);
  if (!versions) {
    return null;
  }
  const [readerGlobalVersion, ...waveVersions] = versions;
  const now = Date.now();
  const versionedKeysByWaveId: Record<string, string> = {};
  const cacheKeysByWaveId: Record<string, string> = {};
  waveIds.forEach((waveId, index) => {
    const keyVersions = [
      waveVersions[index * 2],
      waveVersions[index * 2 + 1],
      readerGlobalVersion
    ];
    const key = summaryCacheKey(identityId, waveId, keyVersions);
    versionedKeysByWaveId[waveId] = key;
    if (areCacheVersionsSettled(keyVersions, now)) {
      cacheKeysByWaveId[waveId] = key;
    }
  });
  return { versionedKeysByWaveId, cacheKeysByWaveId };
}

function uncachedResult(
  waveIds: string[],
  versionedKeysByWaveId: Record<string, string> = {}
): WaveUnreadSummaryCacheReadResult {
  return {
    cachedByWaveId: {},
    uncachedWaveIds: waveIds,
    cacheKeysByWaveId: {},
    versionedKeysByWaveId
  };
}

export async function readWaveUnreadSummaryCache(
  identityId: string,
  waveIds: string[]
): Promise<WaveUnreadSummaryCacheReadResult> {
  const uniqueWaveIds = distinct(waveIds);
  if (uniqueWaveIds.length === 0 || !getRedisClient()) {
    return uncachedResult(uniqueWaveIds);
  }
  const keys = await getVersionedKeys(identityId, uniqueWaveIds);
  if (!keys) {
    recordWaveCacheLookup('wave_unread_summary', {
      error: uniqueWaveIds.length
    });
    return uncachedResult(uniqueWaveIds);
  }
  const { versionedKeysByWaveId, cacheKeysByWaveId } = keys;
  let cachedByKey: Record<string, WaveUnreadSummary>;
  try {
    // Only settled keys can hold a summary; the others were never stored.
    cachedByKey = await redisGetMany<WaveUnreadSummary>(
      Object.values(cacheKeysByWaveId)
    );
  } catch (error) {
    logger.warn('Failed to read wave unread summary cache', error);
    recordWaveCacheLookup('wave_unread_summary', {
      error: uniqueWaveIds.length
    });
    return uncachedResult(uniqueWaveIds, versionedKeysByWaveId);
  }
  const cachedByWaveId: Record<string, WaveUnreadSummary> = {};
  for (const waveId of uniqueWaveIds) {
    const key = cacheKeysByWaveId[waveId];
    const cached = key === undefined ? undefined : cachedByKey[key];
    if (cached) {
      cachedByWaveId[waveId] = cached;
    }
  }
  const hit = Object.keys(cachedByWaveId).length;
  const settling = uniqueWaveIds.length - Object.keys(cacheKeysByWaveId).length;
  recordWaveCacheLookup('wave_unread_summary', {
    hit,
    miss: uniqueWaveIds.length - hit - settling,
    settling
  });
  return {
    cachedByWaveId,
    uncachedWaveIds: uniqueWaveIds.filter((waveId) => !cachedByWaveId[waveId]),
    cacheKeysByWaveId,
    versionedKeysByWaveId
  };
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

export async function withInFlightWaveUnreadSummaryCacheMiss({
  identityId,
  waveIds,
  versionedKeysByWaveId,
  getValue
}: {
  readonly identityId: string;
  readonly waveIds: string[];
  readonly versionedKeysByWaveId: Record<string, string>;
  readonly getValue: () => Promise<Record<string, WaveUnreadSummary>>;
}): Promise<Record<string, WaveUnreadSummary>> {
  const uniqueWaveIds = distinct(waveIds);
  if (!uniqueWaveIds.length) {
    return {};
  }

  const inFlightKey = `${identityId}:${uniqueWaveIds
    .map((waveId) => versionedKeysByWaveId[waveId] ?? waveId)
    .sort(compareCacheStrings)
    .join('|')}`;
  const existing = inFlightSummaryMissReads.get(inFlightKey);
  if (existing !== undefined) {
    return await existing;
  }

  const promise = getValue();
  inFlightSummaryMissReads.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightSummaryMissReads.get(inFlightKey) === promise) {
      inFlightSummaryMissReads.delete(inFlightKey);
    }
  }
}

/**
 * Moves a version key (see wave-cache-version.ts). Fails open (logged): the
 * 5-minute summary TTL bounds the damage of a lost bump.
 */
async function bumpVersion(
  key: string,
  context: Record<string, string>
): Promise<void> {
  try {
    await bumpCacheVersion(key, VERSION_TTL);
  } catch (error) {
    logger.warn('Failed to invalidate wave unread cache', {
      ...context,
      error
    });
  }
}

/** Every reader's summary of the wave: drops added, removed, or rules. */
export async function invalidateWaveUnreadCacheForWave(
  waveId: string
): Promise<void> {
  await bumpVersion(waveVersionKey(waveId), { waveId });
}

export async function invalidateWaveUnreadCacheForWaves(
  waveIds: string[]
): Promise<void> {
  await Promise.allSettled(
    distinct(waveIds).map(invalidateWaveUnreadCacheForWave)
  );
}

/** One reader's summary of one wave: read position, wave mute, membership. */
export async function invalidateWaveUnreadCacheForReaderWave({
  identityId,
  waveId
}: {
  identityId: string;
  waveId: string;
}): Promise<void> {
  await bumpVersion(readerVersionKey(identityId, waveId), {
    identityId,
    waveId
  });
}

export async function invalidateWaveUnreadCacheForReaderWaves(
  readerWaves: WaveUnreadReaderWave[]
): Promise<void> {
  await Promise.allSettled(
    distinctWaveUnreadReaderWaves(readerWaves).map(
      invalidateWaveUnreadCacheForReaderWave
    )
  );
}

/**
 * Every summary of one reader, in all waves: author mutes and blocks, which
 * can touch any wave. One key, so no wave list is needed.
 */
export async function invalidateWaveUnreadCacheForReader(
  identityId: string
): Promise<void> {
  await bumpVersion(readerGlobalVersionKey(identityId), { identityId });
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

/*
 * After-commit variants for writes that may run inside a transaction: the
 * bump waits for COMMIT (a rollback skips it), so no reader can pick up the
 * new version before the change it stands for exists. Without a transaction
 * they bump at once. Repeats within one transaction collapse into one bump.
 */

export async function invalidateWaveUnreadCacheForWaveAfterCommit(
  waveId: string,
  connection: ConnectionWrapper<any> | undefined
): Promise<void> {
  await afterCommit(
    connection,
    () => invalidateWaveUnreadCacheForWave(waveId),
    `wave-unread:wave:${waveId}`
  );
}

export async function invalidateWaveUnreadCacheForWavesAfterCommit(
  waveIds: string[],
  connection: ConnectionWrapper<any> | undefined
): Promise<void> {
  await Promise.all(
    distinct(waveIds).map((waveId) =>
      invalidateWaveUnreadCacheForWaveAfterCommit(waveId, connection)
    )
  );
}

export async function invalidateWaveUnreadCacheForReaderWaveAfterCommit(
  readerWave: WaveUnreadReaderWave,
  connection: ConnectionWrapper<any> | undefined
): Promise<void> {
  await afterCommit(
    connection,
    () => invalidateWaveUnreadCacheForReaderWave(readerWave),
    `wave-unread:reader-wave:${readerWave.identityId}:${readerWave.waveId}`
  );
}

export async function invalidateWaveUnreadCacheForReaderAfterCommit(
  identityId: string,
  connection: ConnectionWrapper<any> | undefined
): Promise<void> {
  await afterCommit(
    connection,
    () => invalidateWaveUnreadCacheForReader(identityId),
    `wave-unread:reader:${identityId}`
  );
}
