import { redisGet, redisSetJson } from '@/redis';
import { withFollowedSubwaveOverviewContextCache } from './wave-followed-subwave-overview-cache';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const redisGetMock = jest.mocked(redisGet);
const redisSetJsonMock = jest.mocked(redisSetJson);

describe('followed subwave overview cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cached context without calling the loader', async () => {
    const cached = {
      'wave-1': {
        followed_subwaves_count: 2,
        latest_followed_subwave_activity_timestamp: 100,
        hidden_followed_subwave_unread_drops: 1,
        first_hidden_followed_subwave_unread_drop_serial_no: 7
      }
    };
    redisGetMock.mockResolvedValue(cached);
    const getValue = jest.fn();

    await expect(
      withFollowedSubwaveOverviewContextCache({
        identityId: 'viewer-1',
        parentWaveIds: ['wave-1'],
        eligibleGroups: ['group-1'],
        cacheable: true,
        getValue
      })
    ).resolves.toBe(cached);

    expect(getValue).not.toHaveBeenCalled();
    expect(redisSetJsonMock).not.toHaveBeenCalled();
  });

  it('coalesces equivalent misses regardless of input ordering', async () => {
    redisGetMock.mockResolvedValue(null);
    const loaded = {
      'wave-1': {
        followed_subwaves_count: 1,
        latest_followed_subwave_activity_timestamp: null,
        hidden_followed_subwave_unread_drops: 0,
        first_hidden_followed_subwave_unread_drop_serial_no: null
      }
    };
    const getValue = jest.fn().mockResolvedValue(loaded);

    await expect(
      Promise.all([
        withFollowedSubwaveOverviewContextCache({
          identityId: 'viewer-1',
          parentWaveIds: ['wave-1', 'wave-2'],
          eligibleGroups: ['group-2', 'group-1'],
          cacheable: true,
          getValue
        }),
        withFollowedSubwaveOverviewContextCache({
          identityId: 'viewer-1',
          parentWaveIds: ['wave-2', 'wave-1'],
          eligibleGroups: ['group-1', 'group-2'],
          cacheable: true,
          getValue
        })
      ])
    ).resolves.toEqual([loaded, loaded]);

    expect(getValue).toHaveBeenCalledTimes(1);
    expect(redisSetJsonMock).toHaveBeenCalledTimes(1);
  });
});
