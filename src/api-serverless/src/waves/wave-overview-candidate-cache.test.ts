import { redisGet, redisSetJson } from '@/redis';
import { withWaveOverviewCandidateCache } from './wave-overview-candidate-cache';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const redisGetMock = jest.mocked(redisGet);
const redisSetJsonMock = jest.mocked(redisSetJson);

describe('wave overview candidate cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached candidates without calling the loader', async () => {
    const cached = [
      {
        waveId: 'wave-1',
        tierRank: 1,
        sortVal: 100,
        latestDropTimestamp: 10
      }
    ];
    redisGetMock.mockResolvedValue(cached);
    const getValue = jest.fn();

    await expect(
      withWaveOverviewCandidateCache({
        keyParts: {
          overviewType: 'scored',
          eligibleGroups: ['group-1']
        },
        getValue
      })
    ).resolves.toBe(cached);

    expect(getValue).not.toHaveBeenCalled();
    expect(redisSetJsonMock).not.toHaveBeenCalled();
  });

  it('coalesces equivalent misses and writes the loaded candidates', async () => {
    redisGetMock.mockResolvedValue(null);
    const loaded = [
      {
        waveId: 'wave-1',
        tierRank: 1,
        sortVal: 100,
        latestDropTimestamp: 10
      }
    ];
    const getValue = jest.fn().mockResolvedValue(loaded);

    await expect(
      Promise.all([
        withWaveOverviewCandidateCache({
          keyParts: {
            b: 2,
            a: 1
          },
          getValue
        }),
        withWaveOverviewCandidateCache({
          keyParts: {
            a: 1,
            b: 2
          },
          getValue
        })
      ])
    ).resolves.toEqual([loaded, loaded]);

    expect(getValue).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/^cache_6529_wave_overview_candidates_v1:/),
      loaded,
      expect.any(Object)
    );
  });
});
