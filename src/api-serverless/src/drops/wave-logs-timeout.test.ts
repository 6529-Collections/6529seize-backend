import { PageSortDirection } from '@/api/page-request';
import { DropLogsQueryParams } from '@/drops/drops.db';
import { redisGet, redisSetJson } from '@/redis';
import {
  WAVE_LOGS_TIMEOUT_CODE,
  WAVE_LOGS_TIMEOUT_TTL,
  WaveLogsUnavailableException,
  withWaveLogsTimeoutGuard
} from './wave-logs-timeout';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const mockedRedisGet = redisGet as jest.MockedFunction<typeof redisGet>;
const mockedRedisSetJson = redisSetJson as jest.MockedFunction<
  typeof redisSetJson
>;

const waveRead: DropLogsQueryParams = {
  wave_id: 'wave-1',
  drop_id: null,
  offset: 0,
  limit: 20,
  log_types: ['DROP_VOTE_EDIT', 'DROP_CREATED'],
  sort_direction: PageSortDirection.DESC
};

const queryTimeout = () =>
  Object.assign(new Error('Query execution was interrupted'), {
    code: 'ER_QUERY_TIMEOUT',
    errno: 3024
  });

describe('withWaveLogsTimeoutGuard', () => {
  beforeEach(() => {
    mockedRedisGet.mockReset().mockResolvedValue(null);
    mockedRedisSetJson.mockReset().mockResolvedValue(undefined);
  });

  it('returns the read result', async () => {
    await expect(
      withWaveLogsTimeoutGuard(waveRead, async () => ['log'])
    ).resolves.toEqual(['log']);
    expect(mockedRedisSetJson).not.toHaveBeenCalled();
  });

  it('runs drop-scoped reads without the guard', async () => {
    const read = jest.fn().mockRejectedValue(queryTimeout());
    await expect(
      withWaveLogsTimeoutGuard({ ...waveRead, drop_id: 'drop-1' }, read)
    ).rejects.toMatchObject({ code: 'ER_QUERY_TIMEOUT' });
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSetJson).not.toHaveBeenCalled();
  });

  it('turns a budget timeout into a 503 and remembers it for a minute', async () => {
    const error = await withWaveLogsTimeoutGuard(waveRead, () =>
      Promise.reject(queryTimeout())
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaveLogsUnavailableException);
    const unavailable = error as WaveLogsUnavailableException;
    expect(unavailable.getStatusCode()).toBe(503);
    expect(unavailable.code).toBe(WAVE_LOGS_TIMEOUT_CODE);
    expect(unavailable.details).toEqual({
      retry_after_seconds: WAVE_LOGS_TIMEOUT_TTL.toSeconds()
    });
    expect(mockedRedisSetJson).toHaveBeenCalledWith(
      'wave-logs-timeout:wave-1:DESC:0:20:DROP_CREATED,DROP_VOTE_EDIT',
      true,
      WAVE_LOGS_TIMEOUT_TTL
    );
  });

  it('answers a remembered timeout without querying again', async () => {
    mockedRedisGet.mockResolvedValue(true);
    const read = jest.fn();
    await expect(withWaveLogsTimeoutGuard(waveRead, read)).rejects.toThrow(
      WaveLogsUnavailableException
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('keys the memory by request shape, not by log type order', async () => {
    await withWaveLogsTimeoutGuard(
      { ...waveRead, log_types: ['DROP_CREATED', 'DROP_VOTE_EDIT'] },
      async () => []
    );
    await withWaveLogsTimeoutGuard({ ...waveRead, offset: 20 }, async () => []);
    await withWaveLogsTimeoutGuard({ ...waveRead, limit: 100 }, async () => []);
    await withWaveLogsTimeoutGuard(
      { ...waveRead, wave_id: 'a:b' },
      async () => []
    );
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      'wave-logs-timeout:wave-1:DESC:0:20:DROP_CREATED,DROP_VOTE_EDIT',
      'wave-logs-timeout:wave-1:DESC:20:20:DROP_CREATED,DROP_VOTE_EDIT',
      'wave-logs-timeout:wave-1:DESC:0:100:DROP_CREATED,DROP_VOTE_EDIT',
      'wave-logs-timeout:a%3Ab:DESC:0:20:DROP_CREATED,DROP_VOTE_EDIT'
    ]);
  });

  it('still reads when the memo cannot be checked', async () => {
    mockedRedisGet.mockRejectedValue(new Error('redis down'));
    await expect(
      withWaveLogsTimeoutGuard(waveRead, async () => ['log'])
    ).resolves.toEqual(['log']);
  });

  it('still answers a timeout with the 503 when the memo cannot be written', async () => {
    mockedRedisSetJson.mockRejectedValue(new Error('redis down'));
    await expect(
      withWaveLogsTimeoutGuard(waveRead, () => Promise.reject(queryTimeout()))
    ).rejects.toBeInstanceOf(WaveLogsUnavailableException);
  });

  it('passes other errors through without remembering them', async () => {
    const failure = new Error('connection lost');
    await expect(
      withWaveLogsTimeoutGuard(waveRead, () => Promise.reject(failure))
    ).rejects.toBe(failure);
    expect(mockedRedisSetJson).not.toHaveBeenCalled();
  });
});
