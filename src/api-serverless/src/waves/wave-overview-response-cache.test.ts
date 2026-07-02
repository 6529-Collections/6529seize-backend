import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import { redisGet, redisSetJson } from '@/redis';
import { withWaveOverviewResponseCache } from './wave-overview-response-cache';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const redisGetMock = jest.mocked(redisGet);
const redisSetJsonMock = jest.mocked(redisSetJson);

describe('wave overview response cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached responses without calling the loader', async () => {
    const cached = {
      data: [{ id: 'wave-1' }],
      page: 1,
      next: false
    };
    redisGetMock.mockResolvedValue(cached as any);
    const getValue = jest.fn();

    await expect(
      withWaveOverviewResponseCache({
        contextProfileId: 'viewer-1',
        eligibleGroups: ['group-1'],
        request: {
          view: ApiWavesV2ListType.Overview,
          page: 1,
          page_size: 10
        } as any,
        getValue
      })
    ).resolves.toBe(cached);

    expect(getValue).not.toHaveBeenCalled();
    expect(redisSetJsonMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent misses and writes the loaded response', async () => {
    redisGetMock.mockResolvedValue(null);
    const loaded = {
      data: [{ id: 'wave-1' }],
      page: 1,
      next: false
    };
    const getValue = jest.fn().mockResolvedValue(loaded);
    const request = {
      view: ApiWavesV2ListType.Overview,
      page: 1,
      page_size: 10
    } as any;

    await expect(
      Promise.all([
        withWaveOverviewResponseCache({
          contextProfileId: 'viewer-1',
          eligibleGroups: ['group-1'],
          request,
          getValue
        }),
        withWaveOverviewResponseCache({
          contextProfileId: 'viewer-1',
          eligibleGroups: ['group-1'],
          request,
          getValue
        })
      ])
    ).resolves.toEqual([loaded, loaded]);

    expect(getValue).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/^cache_6529_api_v2_waves_response_v1:/),
      loaded,
      expect.any(Object)
    );
  });

  it('uses eligible groups to separate otherwise identical cache keys', async () => {
    redisGetMock.mockResolvedValue(null);
    const request = {
      view: ApiWavesV2ListType.Overview,
      page: 1,
      page_size: 10
    } as any;

    await Promise.all([
      withWaveOverviewResponseCache({
        contextProfileId: 'viewer-1',
        eligibleGroups: ['group-1'],
        request,
        getValue: jest.fn().mockResolvedValue({
          data: [{ id: 'wave-1' }],
          page: 1,
          next: false
        })
      }),
      withWaveOverviewResponseCache({
        contextProfileId: 'viewer-1',
        eligibleGroups: ['group-2'],
        request,
        getValue: jest.fn().mockResolvedValue({
          data: [{ id: 'wave-2' }],
          page: 1,
          next: false
        })
      })
    ]);

    const writtenKeys = redisSetJsonMock.mock.calls.map(([key]) => key);
    expect(new Set(writtenKeys).size).toBe(2);
  });
});
