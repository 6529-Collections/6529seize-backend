import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { stableCacheHash } from './wave-cache-key';

export interface WaveOverviewCandidate {
  readonly waveId: string;
  readonly tierRank: number;
  readonly sortVal: number;
  readonly latestDropTimestamp: number;
}

const logger = Logger.get('WAVE_OVERVIEW_CANDIDATE_CACHE');
const CACHE_TTL = Time.seconds(10);
const CACHE_KEY_PREFIX = 'cache_6529_wave_overview_candidates_v1';
const inFlightReads = new Map<string, Promise<WaveOverviewCandidate[]>>();

export async function withWaveOverviewCandidateCache({
  keyParts,
  getValue
}: {
  readonly keyParts: unknown;
  readonly getValue: () => Promise<WaveOverviewCandidate[]>;
}): Promise<WaveOverviewCandidate[]> {
  const cacheKey = `${CACHE_KEY_PREFIX}:${stableCacheHash(keyParts)}`;
  const cached = await readCache(cacheKey);
  if (cached !== null) {
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

async function readCache(
  cacheKey: string
): Promise<WaveOverviewCandidate[] | null> {
  try {
    return await redisGet<WaveOverviewCandidate[]>(cacheKey);
  } catch (error) {
    logger.warn('Failed to read wave overview candidate cache', error);
    return null;
  }
}

async function writeCache(
  cacheKey: string,
  value: WaveOverviewCandidate[]
): Promise<void> {
  try {
    await redisSetJson(cacheKey, value, CACHE_TTL);
  } catch (error) {
    logger.warn('Failed to write wave overview candidate cache', error);
  }
}
