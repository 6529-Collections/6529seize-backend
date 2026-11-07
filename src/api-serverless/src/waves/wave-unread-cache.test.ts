import {
  closeAfterCommitScope,
  openAfterCommitScope,
  runAfterCommitCallbacks
} from '@/db/after-commit';
import { getRedisClient, redisGetMany, redisSetJson } from '@/redis';
import { CACHE_VERSION_SETTLE_MS } from './wave-cache-version';
import {
  invalidateWaveUnreadCacheForReader,
  invalidateWaveUnreadCacheForReaderWave,
  invalidateWaveUnreadCacheForWave,
  invalidateWaveUnreadCacheForWaveAfterCommit,
  readWaveUnreadSummaryCache,
  WAVE_UNREAD_SUMMARY_CACHE_TTL_MAX_SECONDS,
  WAVE_UNREAD_VERSION_TTL,
  waveUnreadSummaryCacheTtlSeconds,
  withInFlightWaveUnreadSummaryCacheMiss,
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

const WAVE_V = 'cache_6529_wave_unread_wave_version_v2';
const READER_V = 'cache_6529_wave_unread_reader_version_v2';
const GLOBAL_V = 'cache_6529_wave_unread_reader_global_version_v2';
const SUMMARY = 'cache_6529_wave_unread_summary_v2';

function settledVersion(tag: string): string {
  return `${Date.now() - CACHE_VERSION_SETTLE_MS - 1_000}.${tag}`;
}

function redisWithVersions(versions: Record<string, string>) {
  return {
    get: jest.fn(async (key: string) => versions[key] ?? null),
    set: jest.fn().mockResolvedValue('OK'),
    mGet: jest.fn(() => {
      throw new Error('CROSSSLOT');
    })
  };
}

describe('wave unread cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisGetManyMock.mockResolvedValue({});
  });

  it('misses all requested waves when Redis is unavailable', async () => {
    getRedisClientMock.mockReturnValue(null);

    await expect(
      readWaveUnreadSummaryCache('reader-1', ['wave-1', 'wave-2'])
    ).resolves.toEqual({
      cachedByWaveId: {},
      uncachedWaveIds: ['wave-1', 'wave-2'],
      cacheKeysByWaveId: {},
      versionedKeysByWaveId: {}
    });
    expect(redisGetManyMock).not.toHaveBeenCalled();
  });

  it('keys summaries on wave, reader and reader-wide versions read one key at a time', async () => {
    const waveVersion = settledVersion('w1');
    const readerVersion = settledVersion('r2');
    const globalVersion = settledVersion('g');
    const redis = redisWithVersions({
      [`${WAVE_V}:wave-1`]: waveVersion,
      [`${READER_V}:reader-1:wave-2`]: readerVersion,
      [`${GLOBAL_V}:reader-1`]: globalVersion
    });
    getRedisClientMock.mockReturnValue(redis as any);
    const wave1Key = `${SUMMARY}:reader-1:wave-1:${waveVersion}:0:${globalVersion}`;
    const wave2Key = `${SUMMARY}:reader-1:wave-2:0:${readerVersion}:${globalVersion}`;
    redisGetManyMock.mockResolvedValue({
      [wave1Key]: { unread_drops_count: 3, first_unread_drop_serial_no: 10 }
    });

    await expect(
      readWaveUnreadSummaryCache('reader-1', ['wave-1', 'wave-2'])
    ).resolves.toEqual({
      cachedByWaveId: {
        'wave-1': { unread_drops_count: 3, first_unread_drop_serial_no: 10 }
      },
      uncachedWaveIds: ['wave-2'],
      cacheKeysByWaveId: { 'wave-1': wave1Key, 'wave-2': wave2Key },
      versionedKeysByWaveId: { 'wave-1': wave1Key, 'wave-2': wave2Key }
    });
    expect(redis.mGet).not.toHaveBeenCalled();
    expect(redis.get.mock.calls.map(([key]) => key)).toEqual([
      `${GLOBAL_V}:reader-1`,
      `${WAVE_V}:wave-1`,
      `${READER_V}:reader-1:wave-1`,
      `${WAVE_V}:wave-2`,
      `${READER_V}:reader-1:wave-2`
    ]);
    expect(redisGetManyMock).toHaveBeenCalledWith([wave1Key, wave2Key]);
  });

  it('fails closed when versions cannot be read', async () => {
    const redis = {
      get: jest.fn().mockRejectedValue(new Error('READONLY')),
      set: jest.fn()
    };
    getRedisClientMock.mockReturnValue(redis as any);

    await expect(
      readWaveUnreadSummaryCache('reader-1', ['wave-1'])
    ).resolves.toEqual({
      cachedByWaveId: {},
      uncachedWaveIds: ['wave-1'],
      cacheKeysByWaveId: {},
      versionedKeysByWaveId: {}
    });
    // Never falls back to version "0" keys, which could hold stale summaries.
    expect(redisGetManyMock).not.toHaveBeenCalled();
  });

  it('neither reads nor stores a summary keyed on a version that just moved', async () => {
    const fresh = `${Date.now()}.fresh`;
    const redis = redisWithVersions({ [`${WAVE_V}:wave-1`]: fresh });
    getRedisClientMock.mockReturnValue(redis as any);

    const result = await readWaveUnreadSummaryCache('reader-1', ['wave-1']);

    expect(result.uncachedWaveIds).toEqual(['wave-1']);
    expect(result.cacheKeysByWaveId).toEqual({});
    expect(result.versionedKeysByWaveId['wave-1']).toContain(fresh);
    expect(redisGetManyMock).toHaveBeenCalledWith([]);

    await writeWaveUnreadSummaryCache({
      summariesByWaveId: {
        'wave-1': { unread_drops_count: 0, first_unread_drop_serial_no: null }
      },
      cacheKeysByWaveId: result.cacheKeysByWaveId
    });
    expect(redisSetJsonMock).not.toHaveBeenCalled();
  });

  it('writes summaries only for known cache keys', async () => {
    await writeWaveUnreadSummaryCache({
      summariesByWaveId: {
        'wave-1': { unread_drops_count: 2, first_unread_drop_serial_no: 12 },
        'wave-2': { unread_drops_count: 0, first_unread_drop_serial_no: null }
      },
      cacheKeysByWaveId: { 'wave-1': 'cache-key-1' }
    });

    expect(redisSetJsonMock).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      'cache-key-1',
      { unread_drops_count: 2, first_unread_drop_serial_no: 12 },
      expect.any(Object)
    );
  });

  it('stores summaries for 60 s unless the TTL env says otherwise', async () => {
    const original = process.env.WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS;
    const write = () =>
      writeWaveUnreadSummaryCache({
        summariesByWaveId: {
          'wave-1': { unread_drops_count: 1, first_unread_drop_serial_no: 1 }
        },
        cacheKeysByWaveId: { 'wave-1': 'cache-key-1' }
      });
    try {
      delete process.env.WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS;
      await write();
      process.env.WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS = '300';
      await write();
      expect(
        redisSetJsonMock.mock.calls.map(([, , ttl]) => ttl?.toSeconds())
      ).toEqual([60, 300]);
    } finally {
      if (original === undefined) {
        delete process.env.WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS;
      } else {
        process.env.WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS = original;
      }
    }
  });

  it.each([
    [undefined, 60],
    ['', 60],
    [' 120 ', 120],
    ['1', 5],
    ['999999', 3600],
    ['-3', 5],
    ['1.5', 60],
    ['five', 60]
  ])('reads WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS=%p as %p s', (raw, ttl) => {
    expect(
      waveUnreadSummaryCacheTtlSeconds(
        raw === undefined ? {} : { WAVE_UNREAD_SUMMARY_CACHE_TTL_SECONDS: raw }
      )
    ).toBe(ttl);
  });

  it('coalesces concurrent misses only for the same versions', async () => {
    const summaries = {
      'wave-1': { unread_drops_count: 2, first_unread_drop_serial_no: 12 }
    };
    const getValue = jest.fn().mockResolvedValue(summaries);
    const params = (key: string) => ({
      identityId: 'reader-1',
      waveIds: ['wave-1'],
      versionedKeysByWaveId: { 'wave-1': key },
      getValue
    });

    await expect(
      Promise.all([
        withInFlightWaveUnreadSummaryCacheMiss(params('key-v1')),
        withInFlightWaveUnreadSummaryCacheMiss(params('key-v1'))
      ])
    ).resolves.toEqual([summaries, summaries]);
    expect(getValue).toHaveBeenCalledTimes(1);

    // A read that began after a change never shares the older read.
    await Promise.all([
      withInFlightWaveUnreadSummaryCacheMiss(params('key-v1')),
      withInFlightWaveUnreadSummaryCacheMiss(params('key-v2'))
    ]);
    expect(getValue).toHaveBeenCalledTimes(3);
  });

  it('moves versions with single-key SETs that carry a TTL and a new value', async () => {
    const redis = redisWithVersions({});
    getRedisClientMock.mockReturnValue(redis as any);

    await invalidateWaveUnreadCacheForWave('wave-1');
    await invalidateWaveUnreadCacheForWave('wave-1');
    await invalidateWaveUnreadCacheForReaderWave({
      identityId: 'reader-1',
      waveId: 'wave-1'
    });
    await invalidateWaveUnreadCacheForReader('reader-1');

    expect(redis.set.mock.calls.map(([key]) => key)).toEqual([
      `${WAVE_V}:wave-1`,
      `${WAVE_V}:wave-1`,
      `${READER_V}:reader-1:wave-1`,
      `${GLOBAL_V}:reader-1`
    ]);
    const [first, second] = redis.set.mock.calls.map(([, value]) => value);
    expect(first).not.toEqual(second);
    expect(first).toMatch(/^\d{13}\.[0-9a-f]{8}$/);
    for (const [, , options] of redis.set.mock.calls) {
      expect(options).toEqual({ EX: expect.any(Number) });
    }
  });

  it('logs and swallows a failed version bump', async () => {
    const redis = { set: jest.fn().mockRejectedValue(new Error('down')) };
    getRedisClientMock.mockReturnValue(redis as any);

    await expect(
      invalidateWaveUnreadCacheForWave('wave-1')
    ).resolves.toBeUndefined();
  });

  it('bumps after COMMIT inside a transaction, once, and never after a rollback', async () => {
    const redis = redisWithVersions({});
    getRedisClientMock.mockReturnValue(redis as any);
    const committed = { connection: {} };
    openAfterCommitScope(committed.connection);

    await invalidateWaveUnreadCacheForWaveAfterCommit('wave-1', committed);
    await invalidateWaveUnreadCacheForWaveAfterCommit('wave-1', committed);
    expect(redis.set).not.toHaveBeenCalled();
    await runAfterCommitCallbacks(closeAfterCommitScope(committed.connection));
    expect(redis.set).toHaveBeenCalledTimes(1);

    const rolledBack = { connection: {} };
    openAfterCommitScope(rolledBack.connection);
    await invalidateWaveUnreadCacheForWaveAfterCommit('wave-2', rolledBack);
    closeAfterCommitScope(rolledBack.connection);
    expect(redis.set).toHaveBeenCalledTimes(1);

    // Outside a transaction it bumps at once.
    await invalidateWaveUnreadCacheForWaveAfterCommit('wave-3', undefined);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('keeps versions far longer than the longest allowed summary TTL', () => {
    // An expired version reads as "0" again: no summary may outlive it.
    expect(WAVE_UNREAD_VERSION_TTL.toSeconds()).toBeGreaterThan(
      100 * WAVE_UNREAD_SUMMARY_CACHE_TTL_MAX_SECONDS
    );
  });
});
