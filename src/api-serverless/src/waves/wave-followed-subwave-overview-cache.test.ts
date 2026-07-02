import { redisGet, redisSetJson } from '@/redis';
import {
  withFollowedSubwaveOverviewContextCache,
  withInFlightFollowedSubwaveUnreadRead
} from './wave-followed-subwave-overview-cache';

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
        latest_followed_subwave_activity_timestamp: 100
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
        latest_followed_subwave_activity_timestamp: null
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

  it('coalesces equivalent hidden unread reads without caching them', async () => {
    const loaded = [
      {
        parent_wave_id: 'wave-1',
        hidden_followed_subwave_unread_drops: 2,
        first_hidden_followed_subwave_unread_drop_serial_no: 10
      }
    ];
    const getValue = jest.fn().mockResolvedValue(loaded);

    await expect(
      Promise.all([
        withInFlightFollowedSubwaveUnreadRead({
          identityId: 'viewer-1',
          parentWaveIds: ['wave-1', 'wave-2'],
          eligibleGroups: ['group-2', 'group-1'],
          getValue
        }),
        withInFlightFollowedSubwaveUnreadRead({
          identityId: 'viewer-1',
          parentWaveIds: ['wave-2', 'wave-1'],
          eligibleGroups: ['group-1', 'group-2'],
          getValue
        })
      ])
    ).resolves.toEqual([loaded, loaded]);

    expect(getValue).toHaveBeenCalledTimes(1);
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisSetJsonMock).not.toHaveBeenCalled();

    await withInFlightFollowedSubwaveUnreadRead({
      identityId: 'viewer-1',
      parentWaveIds: ['wave-1'],
      eligibleGroups: ['group-1'],
      getValue
    });

    expect(getValue).toHaveBeenCalledTimes(2);
  });
});
