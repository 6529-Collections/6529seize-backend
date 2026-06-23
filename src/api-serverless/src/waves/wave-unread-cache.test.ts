import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import {
  invalidateWaveUnreadCacheForReaderWave,
  invalidateWaveUnreadCacheForWave,
  readWaveUnreadSummaryCache,
  writeWaveUnreadSummaryCache
} from './wave-unread-cache';

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn(),
  redisGetMany: jest.fn(),
  redisSetJson: jest.fn()
}));

const getRedisClientMock = jest.mocked(getRedisClient);
const redisGetManyMock = jest.mocked(redisGetMany);
const redisSetJsonMock = jest.mocked(redisSetJson);

describe('wave unread cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('misses all requested waves when Redis is unavailable', async () => {
    getRedisClientMock.mockReturnValue(null);

    await expect(
      readWaveUnreadSummaryCache('reader-1', ['wave-1', 'wave-2'])
    ).resolves.toEqual({
      cachedByWaveId: {},
      uncachedWaveIds: ['wave-1', 'wave-2'],
      cacheKeysByWaveId: {}
    });
    expect(redisGetManyMock).not.toHaveBeenCalled();
  });

  it('uses wave and reader versions in cache keys', async () => {
    const redis = {
      mGet: jest
        .fn()
        .mockResolvedValueOnce(['4', null])
        .mockResolvedValueOnce(['9', '2'])
    };
    getRedisClientMock.mockReturnValue(redis as any);
    redisGetManyMock.mockResolvedValue({
      'cache_6529_wave_unread_summary_v1:reader-1:wave-1:4:9': {
        unread_drops_count: 3,
        first_unread_drop_serial_no: 10
      }
    });

    await expect(
      readWaveUnreadSummaryCache('reader-1', ['wave-1', 'wave-2'])
    ).resolves.toEqual({
      cachedByWaveId: {
        'wave-1': {
          unread_drops_count: 3,
          first_unread_drop_serial_no: 10
        }
      },
      uncachedWaveIds: ['wave-2'],
      cacheKeysByWaveId: {
        'wave-1': 'cache_6529_wave_unread_summary_v1:reader-1:wave-1:4:9',
        'wave-2': 'cache_6529_wave_unread_summary_v1:reader-1:wave-2:0:2'
      }
    });
    expect(redis.mGet).toHaveBeenNthCalledWith(1, [
      'cache_6529_wave_unread_wave_version_v1:wave-1',
      'cache_6529_wave_unread_wave_version_v1:wave-2'
    ]);
    expect(redis.mGet).toHaveBeenNthCalledWith(2, [
      'cache_6529_wave_unread_reader_version_v1:reader-1:wave-1',
      'cache_6529_wave_unread_reader_version_v1:reader-1:wave-2'
    ]);
  });

  it('writes summaries only for known cache keys', async () => {
    await writeWaveUnreadSummaryCache({
      summariesByWaveId: {
        'wave-1': {
          unread_drops_count: 2,
          first_unread_drop_serial_no: 12
        },
        'wave-2': {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        }
      },
      cacheKeysByWaveId: {
        'wave-1': 'cache-key-1'
      }
    });

    expect(redisSetJsonMock).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      'cache-key-1',
      {
        unread_drops_count: 2,
        first_unread_drop_serial_no: 12
      },
      expect.any(Object)
    );
  });

  it('bumps version keys for wave and reader invalidation', async () => {
    const redis = { incr: jest.fn().mockResolvedValue(1) };
    getRedisClientMock.mockReturnValue(redis as any);

    await invalidateWaveUnreadCacheForWave('wave-1');
    await invalidateWaveUnreadCacheForReaderWave({
      identityId: 'reader-1',
      waveId: 'wave-1'
    });

    expect(redis.incr).toHaveBeenCalledWith(
      'cache_6529_wave_unread_wave_version_v1:wave-1'
    );
    expect(redis.incr).toHaveBeenCalledWith(
      'cache_6529_wave_unread_reader_version_v1:reader-1:wave-1'
    );
  });
});
