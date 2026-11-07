import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { CACHE_VERSION_SETTLE_MS } from './wave-cache-version';
import {
  DROP_CONTENT_VERSION_TTL,
  invalidateWaveOverviewStaticCacheForDrops,
  WAVE_OVERVIEW_STATIC_CACHE_TTL,
  readWaveOverviewStaticCache,
  withInFlightWaveOverviewStaticCacheRead,
  writeWaveOverviewStaticCache
} from './wave-overview-static-cache';

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn(),
  redisGetMany: jest.fn(),
  redisSetJson: jest.fn()
}));

const getRedisClientMock = jest.mocked(getRedisClient);
const redisGetManyMock = jest.mocked(redisGetMany);
const redisSetJsonMock = jest.mocked(redisSetJson);
const DROP_V = 'cache_6529_drop_content_version_v1';

function makeWave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    created_by: 'creator-1',
    description_drop_id: 'description-drop-1',
    updated_at: null,
    ...overrides
  } as any;
}

function redisWithVersions(versions: Record<string, string> = {}) {
  const redis = {
    get: jest.fn(async (key: string) => versions[key] ?? null),
    set: jest.fn().mockResolvedValue('OK')
  };
  getRedisClientMock.mockReturnValue(redis as any);
  return redis;
}

const entry = {
  descriptionDropPartOne: null,
  descriptionDropPartOneMedia: []
};

describe('wave overview static cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisGetManyMock.mockResolvedValue({});
  });

  it('maps cached entries by wave id and reports misses', async () => {
    const redis = redisWithVersions();
    redisGetManyMock.mockImplementation(async (keys: string[]) => ({
      [keys[0]]: entry
    }));

    const result = await readWaveOverviewStaticCache([
      makeWave({ id: 'wave-1' }),
      makeWave({ id: 'wave-2', description_drop_id: 'description-drop-2' })
    ]);

    expect(result).toEqual({
      cachedByWaveId: { 'wave-1': entry },
      uncachedWaveIds: ['wave-2'],
      cacheKeysByWaveId: {
        'wave-1': expect.stringMatching(
          /^cache_6529_wave_overview_static_v2:wave-1:[0-9a-f]{64}:0$/
        ),
        'wave-2': expect.stringMatching(
          /^cache_6529_wave_overview_static_v2:wave-2:[0-9a-f]{64}:0$/
        )
      },
      versionedKeysByWaveId: result.cacheKeysByWaveId
    });
    expect(redis.get.mock.calls.map(([key]) => key)).toEqual([
      `${DROP_V}:description-drop-1`,
      `${DROP_V}:description-drop-2`
    ]);
  });

  it('keys entries on the description drop content version', async () => {
    redisWithVersions();
    const before = await readWaveOverviewStaticCache([makeWave()]);
    const settled = `${Date.now() - CACHE_VERSION_SETTLE_MS - 1}.abc`;
    redisWithVersions({ [`${DROP_V}:description-drop-1`]: settled });
    const after = await readWaveOverviewStaticCache([makeWave()]);

    expect(after.cacheKeysByWaveId['wave-1']).not.toEqual(
      before.cacheKeysByWaveId['wave-1']
    );
    expect(after.cacheKeysByWaveId['wave-1']).toMatch(
      new RegExp(`:${settled}$`)
    );
  });

  it('does not read or store an entry while its drop version is settling', async () => {
    redisWithVersions({
      [`${DROP_V}:description-drop-1`]: `${Date.now()}.fresh`
    });

    const result = await readWaveOverviewStaticCache([makeWave()]);

    expect(result.cacheKeysByWaveId).toEqual({});
    expect(result.versionedKeysByWaveId['wave-1']).toContain('fresh');
    expect(result.uncachedWaveIds).toEqual(['wave-1']);
    expect(redisGetManyMock).toHaveBeenCalledWith([]);
  });

  it('fails closed when versions cannot be read', async () => {
    getRedisClientMock.mockReturnValue({
      get: jest.fn().mockRejectedValue(new Error('down'))
    } as any);

    const result = await readWaveOverviewStaticCache([makeWave()]);

    expect(result.cacheKeysByWaveId).toEqual({});
    expect(result.uncachedWaveIds).toEqual(['wave-1']);
    expect(redisGetManyMock).not.toHaveBeenCalled();
  });

  it('stores only the viewer-neutral fields', async () => {
    await writeWaveOverviewStaticCache({
      entriesByWaveId: {
        'wave-1': { ...entry, creator: { subscribed_actions: ['DROP'] } } as any
      },
      cacheKeysByWaveId: { 'wave-1': 'cache-key-1' }
    });

    expect(redisSetJsonMock).toHaveBeenCalledWith(
      'cache-key-1',
      entry,
      expect.any(Object)
    );
  });

  it('does not store entries whose media is still processing', async () => {
    const media = (media_status: DropMediaUploadStatus | null) =>
      ({ id: 'm', drop_id: 'd', media_status }) as any;

    await writeWaveOverviewStaticCache({
      entriesByWaveId: {
        processing: {
          descriptionDropPartOne: null,
          descriptionDropPartOneMedia: [
            media(DropMediaUploadStatus.READY),
            media(DropMediaUploadStatus.PROCESSING)
          ]
        },
        settled: {
          descriptionDropPartOne: null,
          descriptionDropPartOneMedia: [
            media(DropMediaUploadStatus.READY),
            media(DropMediaUploadStatus.FAILED),
            media(null)
          ]
        }
      },
      cacheKeysByWaveId: { processing: 'key-p', settled: 'key-s' }
    });

    expect(redisSetJsonMock.mock.calls.map(([key]) => key)).toEqual(['key-s']);
  });

  it('coalesces equivalent miss loads only for the same versions', async () => {
    const loaded = { 'wave-1': entry };
    const getValue = jest.fn().mockResolvedValue(loaded);
    const read = (key: string) =>
      withInFlightWaveOverviewStaticCacheRead({
        versionedKeysByWaveId: { 'wave-1': key },
        waveIds: ['wave-1'],
        getValue
      });

    await expect(Promise.all([read('k1'), read('k1')])).resolves.toEqual([
      loaded,
      loaded
    ]);
    expect(getValue).toHaveBeenCalledTimes(1);
    await Promise.all([read('k1'), read('k2')]);
    expect(getValue).toHaveBeenCalledTimes(3);
  });

  it('normalizes date-shaped updated_at values in cache keys', async () => {
    redisWithVersions();
    const updatedAt = new Date(1700000000000);

    const dateResult = await readWaveOverviewStaticCache([
      makeWave({ updated_at: updatedAt })
    ]);
    const timestampResult = await readWaveOverviewStaticCache([
      makeWave({ updated_at: updatedAt.getTime() })
    ]);

    expect(dateResult.cacheKeysByWaveId['wave-1']).toEqual(
      timestampResult.cacheKeysByWaveId['wave-1']
    );
  });

  it('moves drop content versions with single-key SETs', async () => {
    const redis = redisWithVersions();

    await invalidateWaveOverviewStaticCacheForDrops(['d1', 'd2', 'd1']);

    expect(redis.set.mock.calls.map(([key]) => key)).toEqual([
      `${DROP_V}:d1`,
      `${DROP_V}:d2`
    ]);
  });

  it('keeps drop content versions far longer than any entry keyed on them', () => {
    // An expired version reads as "0" again: no entry may outlive it.
    expect(DROP_CONTENT_VERSION_TTL.toSeconds()).toBeGreaterThan(
      100 * WAVE_OVERVIEW_STATIC_CACHE_TTL.toSeconds()
    );
  });
});
