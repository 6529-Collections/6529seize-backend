import { UserGroupsService } from './user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '@/entities/IUserGroup';
import { getRedisClient, WAVE_GROUPS_VERSION_CACHE_KEY } from '@/redis';
import { Time } from '@/time';
import * as mcache from 'memory-cache';
import { AbusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn()
}));

type RedisMock = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

const PROFILE_ID = 'profile-1';
const GROUP_ID = 'group-1';
const ELIGIBLE_GROUPS_CACHE_KEY = `cache_6529_eligible_groups:${PROFILE_ID}`;

function buildRedisMock(): RedisMock {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1)
  };
}

function buildUserGroup(): UserGroupEntity {
  return {
    id: GROUP_ID,
    name: 'Group 1',
    cic_min: null,
    cic_max: null,
    cic_user: null,
    cic_direction: null,
    rep_min: null,
    rep_max: null,
    rep_user: null,
    rep_direction: null,
    rep_category: null,
    tdh_min: null,
    tdh_max: null,
    tdh_inclusion_strategy: GroupTdhInclusionStrategy.TDH,
    level_min: null,
    level_max: null,
    created_at: new Date(),
    created_by: PROFILE_ID,
    visible: true,
    owns_meme: false,
    owns_meme_tokens: null,
    owns_gradient: false,
    owns_gradient_tokens: null,
    owns_nextgen: false,
    owns_nextgen_tokens: null,
    owns_lab: false,
    owns_lab_tokens: null,
    profile_group_id: 'profile-group-1',
    excluded_profile_group_id: null,
    is_pure_profile_group: true,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null
  } as UserGroupEntity;
}

function buildUserGroupsDbMock() {
  return {
    getLatestProfileGroupChangeMillis: jest.fn().mockResolvedValue(null),
    getAllWaveRelatedGroups: jest.fn().mockResolvedValue([GROUP_ID]),
    getIdentityByProfileId: jest.fn().mockResolvedValue({
      profile_id: PROFILE_ID,
      rep: 0,
      cic: 0,
      tdh: 0,
      xtdh: 0,
      level_raw: 0
    }),
    getByIds: jest.fn().mockResolvedValue([buildUserGroup()]),
    getGroupsUserIsEligibleByIdentity: jest.fn().mockResolvedValue([GROUP_ID]),
    getGroupsUserIsExcludedFromByIdentity: jest.fn().mockResolvedValue([])
  };
}

function buildService(userGroupsDb = buildUserGroupsDbMock()) {
  return new UserGroupsService(
    userGroupsDb as unknown as UserGroupsDb,
    {} as unknown as AbusivenessCheckService,
    {} as unknown as MetricsRecorder
  );
}

describe('UserGroupsService eligibility cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mcache.clear();
    delete process.env.USER_GROUPS_ELIGIBILITY_CACHE_TTL_SEC;
  });

  it('returns valid Redis profile cache without loading wave groups', async () => {
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: [GROUP_ID],
            computedAtMillis: 1_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
    expect(userGroupsDb.getByIds).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ignores Redis profile cache when profile groups changed later', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(3_000);
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: ['stale-group'],
            computedAtMillis: 1_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    userGroupsDb.getLatestProfileGroupChangeMillis.mockResolvedValue(2_000);
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      ELIGIBLE_GROUPS_CACHE_KEY,
      JSON.stringify({
        eligibleGroupIds: [GROUP_ID],
        computedAtMillis: 3_000,
        waveGroupsVersion: 7
      }),
      { EX: 60 }
    );
  });

  it('ignores Redis profile cache when wave groups version differs', async () => {
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('8');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: ['stale-group'],
            computedAtMillis: 1_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
  });

  it('falls back to computation when Redis profile cache is malformed', async () => {
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        return Promise.resolve('{');
      }
      return Promise.resolve(null);
    });
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent same-profile computations inside one process', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const userGroupsDb = buildUserGroupsDbMock();
    let resolveGroups: (groups: string[]) => void = () => undefined;
    const groupsPromise = new Promise<string[]>((resolve) => {
      resolveGroups = resolve;
    });
    userGroupsDb.getAllWaveRelatedGroups.mockReturnValue(groupsPromise);
    const service = buildService(userGroupsDb);

    const first = service.getGroupsUserIsEligibleFor(PROFILE_ID);
    const second = service.getGroupsUserIsEligibleFor(PROFILE_ID);
    resolveGroups([GROUP_ID]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [GROUP_ID],
      [GROUP_ID]
    ]);
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
  });
});
