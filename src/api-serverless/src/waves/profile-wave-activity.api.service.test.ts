import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { ApiProfileWaveActivityType } from '@/api/generated/models/ApiProfileWaveActivityType';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { NotFoundException } from '@/exceptions';
import { ProfileWaveActivityApiService } from './profile-wave-activity.api.service';
import { ProfileWaveActivityCursorCodec } from './profile-wave-activity.cursor';
import { WavesApiDb } from './waves.api.db';

describe('ProfileWaveActivityApiService', () => {
  const getProfileIdByIdentityKeyOrThrow = jest.fn();
  const findCreatedProfileWaveActivity = jest.fn();
  const findRecentProfileWaveActivity = jest.fn();
  const decodeCreated = jest.fn();
  const decodeRecent = jest.fn();
  const encodeCreated = jest.fn();
  const encodeRecent = jest.fn();
  const service = new ProfileWaveActivityApiService(
    { getProfileIdByIdentityKeyOrThrow } as unknown as IdentityFetcher,
    {} as UserGroupsService,
    {
      findCreatedProfileWaveActivity,
      findRecentProfileWaveActivity
    } as unknown as WavesApiDb,
    {
      decodeCreated,
      decodeRecent,
      encodeCreated,
      encodeRecent
    } as unknown as ProfileWaveActivityCursorCodec
  );

  beforeEach(() => {
    jest.clearAllMocks();
    getProfileIdByIdentityKeyOrThrow.mockResolvedValue('profile-1');
    decodeCreated.mockReturnValue(null);
    decodeRecent.mockReturnValue(null);
    encodeCreated.mockReturnValue('next-created');
    encodeRecent.mockReturnValue('next-recent');
    findCreatedProfileWaveActivity.mockResolvedValue([]);
    findRecentProfileWaveActivity.mockResolvedValue([]);
  });

  it('fetches limit + 1 candidates, maps flat fields, and encodes the page boundary', async () => {
    findCreatedProfileWaveActivity.mockResolvedValue([
      {
        waveId: 'wave-3',
        waveName: 'Wave Three',
        wavePicture: 'picture-3',
        isPrivate: true,
        totalDropsCount: 30,
        latestPostTimestamp: 300,
        hasQualifyingPost: true,
        waveSerialNo: 3
      },
      {
        waveId: 'wave-2',
        waveName: 'Wave Two',
        wavePicture: null,
        isPrivate: false,
        totalDropsCount: 20,
        latestPostTimestamp: null,
        hasQualifyingPost: false,
        waveSerialNo: 2
      },
      {
        waveId: 'wave-1',
        waveName: 'Wave One',
        wavePicture: null,
        isPrivate: false,
        totalDropsCount: 10,
        latestPostTimestamp: null,
        hasQualifyingPost: false,
        waveSerialNo: 1
      }
    ]);

    await expect(
      service.getProfileWaveActivity(
        {
          identity: 'alice',
          activityType: ApiProfileWaveActivityType.Created,
          limit: 2
        },
        {}
      )
    ).resolves.toEqual({
      data: [
        {
          wave_id: 'wave-3',
          wave_name: 'Wave Three',
          wave_picture: 'picture-3',
          is_private: true,
          total_drops_count: 30,
          latest_post_timestamp: 300
        },
        {
          wave_id: 'wave-2',
          wave_name: 'Wave Two',
          wave_picture: null,
          is_private: false,
          total_drops_count: 20,
          latest_post_timestamp: null
        }
      ],
      next_cursor: 'next-created'
    });

    expect(getProfileIdByIdentityKeyOrThrow).toHaveBeenCalledTimes(1);
    expect(findCreatedProfileWaveActivity).toHaveBeenCalledWith(
      {
        profileId: 'profile-1',
        eligibleGroups: [],
        limit: 3,
        cursor: null
      },
      expect.any(Object)
    );
    expect(encodeCreated).toHaveBeenCalledWith('profile-1', {
      hasQualifyingPost: 0,
      latestPostTimestamp: 0,
      waveSerialNo: 2,
      waveId: 'wave-2'
    });
    expect(findRecentProfileWaveActivity).not.toHaveBeenCalled();
  });

  it('returns an explicit null cursor when RECENT has no extra candidate', async () => {
    findRecentProfileWaveActivity.mockResolvedValue([
      {
        waveId: 'wave-1',
        waveName: 'Wave One',
        wavePicture: null,
        isPrivate: false,
        totalDropsCount: 1,
        latestPostTimestamp: 100
      }
    ]);

    const result = await service.getProfileWaveActivity(
      {
        identity: 'alice',
        activityType: ApiProfileWaveActivityType.Recent,
        limit: 1
      },
      {}
    );

    expect(result.next_cursor).toBeNull();
    expect(findRecentProfileWaveActivity).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, cursor: null }),
      expect.any(Object)
    );
    expect(encodeRecent).not.toHaveBeenCalled();
  });

  it('propagates identity not-found errors as API 404 errors', async () => {
    const error = new NotFoundException('Profile not found');
    getProfileIdByIdentityKeyOrThrow.mockRejectedValue(error);

    await expect(
      service.getProfileWaveActivity(
        {
          identity: 'missing',
          activityType: ApiProfileWaveActivityType.Created,
          limit: 20
        },
        {}
      )
    ).rejects.toBe(error);

    expect(error.getStatusCode()).toBe(404);
    expect(findCreatedProfileWaveActivity).not.toHaveBeenCalled();
    expect(findRecentProfileWaveActivity).not.toHaveBeenCalled();
  });
});
