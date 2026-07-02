import { redisGetMany, redisSetJson } from '@/redis';
import {
  readWaveOverviewStaticCache,
  withInFlightWaveOverviewStaticCacheRead,
  writeWaveOverviewStaticCache
} from './wave-overview-static-cache';

jest.mock('@/redis', () => ({
  redisGetMany: jest.fn(),
  redisSetJson: jest.fn()
}));

const redisGetManyMock = jest.mocked(redisGetMany);
const redisSetJsonMock = jest.mocked(redisSetJson);

function makeWave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    created_by: 'creator-1',
    description_drop_id: 'description-drop-1',
    updated_at: null,
    ...overrides
  } as any;
}

describe('wave overview static cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps cached entries by wave id and reports misses', async () => {
    const cachedEntry = {
      metrics: null,
      descriptionDropPartOne: null,
      descriptionDropPartOneMedia: [],
      creator: null
    };
    redisGetManyMock.mockImplementation(async (keys: string[]) => ({
      [keys[0]]: cachedEntry
    }));

    await expect(
      readWaveOverviewStaticCache([
        makeWave({ id: 'wave-1' }),
        makeWave({ id: 'wave-2' })
      ])
    ).resolves.toEqual({
      cachedByWaveId: {
        'wave-1': cachedEntry
      },
      uncachedWaveIds: ['wave-2'],
      cacheKeysByWaveId: expect.objectContaining({
        'wave-1': expect.stringMatching(
          /^cache_6529_wave_overview_static_v1:wave-1:/
        ),
        'wave-2': expect.stringMatching(
          /^cache_6529_wave_overview_static_v1:wave-2:/
        )
      })
    });
  });

  it('writes entries and coalesces equivalent miss loads', async () => {
    const loaded = {
      'wave-1': {
        metrics: null,
        descriptionDropPartOne: null,
        descriptionDropPartOneMedia: [],
        creator: null
      }
    };
    const getValue = jest.fn().mockResolvedValue(loaded);

    await expect(
      Promise.all([
        withInFlightWaveOverviewStaticCacheRead({
          cacheKeysByWaveId: { 'wave-1': 'cache-key-1' },
          waveIds: ['wave-1'],
          getValue
        }),
        withInFlightWaveOverviewStaticCacheRead({
          cacheKeysByWaveId: { 'wave-1': 'cache-key-1' },
          waveIds: ['wave-1'],
          getValue
        })
      ])
    ).resolves.toEqual([loaded, loaded]);

    await writeWaveOverviewStaticCache({
      entriesByWaveId: loaded,
      cacheKeysByWaveId: { 'wave-1': 'cache-key-1' }
    });

    expect(getValue).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      'cache-key-1',
      loaded['wave-1'],
      expect.any(Object)
    );
  });
});
