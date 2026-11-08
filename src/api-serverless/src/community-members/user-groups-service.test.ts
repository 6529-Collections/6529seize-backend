import { NewUserGroupEntity, UserGroupsService } from './user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  FilterDirection,
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '@/entities/IUserGroup';
import { XTdhGrantEntity, XTdhGrantTokenMode } from '@/entities/IXTdhGrant';
import { RateMatter } from '@/entities/IRating';
import { MEMES_CONTRACT } from '@/constants';
import {
  getRedisClient,
  waitForRedisReady,
  WAVE_GROUPS_CACHE_GENERATION_KEY,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
  WAVE_GROUPS_CACHE_STAMP_KEY,
  WAVE_GROUPS_VERSION_CACHE_KEY
} from '@/redis';
import { SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import * as mcache from 'memory-cache';
import { AbusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import fc from 'fast-check';
import { xTdhRepository } from '@/xtdh/xtdh.repository';
import { ApiCreateGroupDescription } from '@/api/generated/models/ApiCreateGroupDescription';
import { ApiGroupOwnsNftNameEnum } from '@/api/generated/models/ApiGroupOwnsNft';

function buildPreviewGroup(
  overrides: Partial<ApiCreateGroupDescription> = {}
): ApiCreateGroupDescription {
  return {
    cic: { min: null, max: null, user_identity: null, direction: null },
    rep: {
      min: null,
      max: null,
      user_identity: null,
      direction: null,
      category: null
    },
    level: { min: null, max: null },
    tdh: {
      min: null,
      max: null,
      inclusion_strategy: GroupTdhInclusionStrategy.TDH as never
    },
    owns_nfts: [],
    identity_addresses: [],
    excluded_identity_addresses: [],
    ...overrides
  };
}

function buildGrant(overrides: Partial<XTdhGrantEntity> = {}): XTdhGrantEntity {
  return Object.assign(new XTdhGrantEntity(), {
    token_mode: XTdhGrantTokenMode.ALL,
    ...overrides
  });
}

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn(),
  waitForRedisReady: jest.fn().mockResolvedValue(true)
}));

type RedisMock = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
};

const PROFILE_ID = 'profile-1';
const GROUP_ID = 'group-1';
const ELIGIBLE_GROUPS_CACHE_KEY = `cache_6529_eligible_groups:${PROFILE_ID}`;
const ELIGIBLE_GROUPS_LOCK_KEY = `cache_6529_eligible_groups_lease:{${ELIGIBLE_GROUPS_CACHE_KEY}}`;

function buildRedisMock(): RedisMock {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1)
  };
}

/**
 * Answers the catalogue probe as Redis would for this blob (stamped by the
 * current build, generation 0), and 1 otherwise.
 */
function answerCatalogueProbe(redis: RedisMock, blob: string | null) {
  const bytes = blob ? Buffer.byteLength(blob, 'utf8') : 0;
  const stamp = blob
    ? JSON.stringify({ generation: '0', hash: 'h', bytes, publishedAt: 1 })
    : null;
  redis.eval.mockImplementation((script: string) =>
    Promise.resolve(script.includes('STRLEN') ? [bytes, stamp, '0'] : 1)
  );
}

/** The eval call that published the eligibility result, if any. */
function eligibilityResultPublishes(redis: RedisMock) {
  return redis.eval.mock.calls.filter(([, options]) =>
    (options as { keys?: string[] } | undefined)?.keys?.includes(
      ELIGIBLE_GROUPS_CACHE_KEY
    )
  );
}

function buildUserGroup(
  overrides: Partial<UserGroupEntity> = {}
): UserGroupEntity {
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
    owns_meme_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_gradient: false,
    owns_gradient_tokens: null,
    owns_gradient_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_nextgen: false,
    owns_nextgen_tokens: null,
    owns_nextgen_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_lab: false,
    owns_lab_tokens: null,
    owns_lab_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    profile_group_id: 'profile-group-1',
    excluded_profile_group_id: null,
    is_pure_profile_group: true,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null,
    is_beneficiary_of_grant_match_mode:
      GroupBeneficiaryGrantMatchMode.ANY_TOKEN,
    ...overrides
  } as UserGroupEntity;
}

type SaveUserGroup = Omit<
  NewUserGroupEntity,
  'profile_group_id' | 'excluded_profile_group_id'
> & {
  addresses: string[];
  excluded_addresses: string[];
};

function buildSaveUserGroup(
  overrides: Partial<SaveUserGroup> = {}
): SaveUserGroup {
  return {
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
    visible: true,
    owns_meme: false,
    owns_meme_tokens: null,
    owns_meme_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_gradient: false,
    owns_gradient_tokens: null,
    owns_gradient_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_nextgen: false,
    owns_nextgen_tokens: null,
    owns_nextgen_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_lab: false,
    owns_lab_tokens: null,
    owns_lab_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null,
    is_beneficiary_of_grant_match_mode:
      GroupBeneficiaryGrantMatchMode.ANY_TOKEN,
    addresses: [],
    excluded_addresses: [],
    ...overrides
  };
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
    getGroupsUserIsExcludedFromByIdentity: jest.fn().mockResolvedValue([]),
    getGivenCicAndRep: jest.fn().mockResolvedValue({ cic: 0, rep: 0 }),
    getAllProfileOwnedTokensByProfileIdGroupedByContract: jest
      .fn()
      .mockResolvedValue({}),
    getRatings: jest.fn().mockResolvedValue([]),
    findBeneficiaryGrantGroupIdsForProfile: jest.fn().mockResolvedValue([])
  };
}

function buildService(userGroupsDb: unknown = buildUserGroupsDbMock()) {
  return new UserGroupsService(
    userGroupsDb as unknown as UserGroupsDb,
    {} as unknown as AbusivenessCheckService,
    {} as unknown as MetricsRecorder
  );
}

function isInvalidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return false;
  } catch {
    return true;
  }
}

describe('UserGroupsService save validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  function buildTransactionalDbMock() {
    return {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({ id: 'connection' })
      )
    };
  }

  it('rejects all-token beneficiary grant matching without a grant', async () => {
    const userGroupsDb = buildTransactionalDbMock();
    const service = buildService(userGroupsDb as unknown as UserGroupsDb);

    await expect(
      service.save(
        buildSaveUserGroup({
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        }),
        PROFILE_ID,
        {}
      )
    ).rejects.toThrow('requires an xTDH grant');
  });

  it('rejects all-token beneficiary grant matching for full-collection grants', async () => {
    jest.spyOn(xTdhRepository, 'getGrantById').mockResolvedValue(buildGrant());
    const userGroupsDb = buildTransactionalDbMock();
    const service = buildService(userGroupsDb as unknown as UserGroupsDb);

    await expect(
      service.save(
        buildSaveUserGroup({
          is_beneficiary_of_grant_id: 'grant-1',
          is_beneficiary_of_grant_match_mode:
            GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        }),
        PROFILE_ID,
        {}
      )
    ).rejects.toThrow(
      'can only be used with grants that specify target tokens'
    );
  });
});

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
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        keys: expect.arrayContaining([ELIGIBLE_GROUPS_CACHE_KEY]),
        arguments: expect.arrayContaining([
          JSON.stringify({
            eligibleGroupIds: [GROUP_ID],
            computedAtMillis: 3_000,
            waveGroupsVersion: 7,
            invalidation: ''
          })
        ])
      })
    );
  });

  it('does not cache computed results when profile groups change during computation', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(3_000);
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    userGroupsDb.getLatestProfileGroupChangeMillis
      .mockResolvedValueOnce(1_000)
      .mockResolvedValueOnce(1_000)
      .mockResolvedValueOnce(2_500);
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).rejects.toMatchObject({ status: 503 });
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      ELIGIBLE_GROUPS_LOCK_KEY,
      expect.any(String),
      {
        PX: 8_000,
        NX: true
      }
    );
    expect(
      eligibilityResultPublishes(redis).filter(([script]) =>
        String(script).includes("redis.call('SET', KEYS[2]")
      )
    ).toEqual([]);
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

  it('uses Redis profile cache produced by peer when lock is already held', async () => {
    const redis = buildRedisMock();
    let eligibleGroupsCacheReads = 0;
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        eligibleGroupsCacheReads++;
        if (eligibleGroupsCacheReads === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: [GROUP_ID],
            computedAtMillis: 3_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    redis.set.mockResolvedValueOnce(null);
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      ELIGIBLE_GROUPS_LOCK_KEY,
      expect.any(String),
      {
        PX: 8_000,
        NX: true
      }
    );
  });

  it('falls back to computation when Redis profile cache is malformed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string().filter(isInvalidJson),
          fc.constantFrom(
            JSON.stringify(null),
            JSON.stringify([]),
            JSON.stringify({
              eligibleGroupIds: GROUP_ID,
              computedAtMillis: 1_000,
              waveGroupsVersion: 7
            }),
            JSON.stringify({
              eligibleGroupIds: [GROUP_ID],
              computedAtMillis: '1_000',
              waveGroupsVersion: 7
            }),
            JSON.stringify({
              eligibleGroupIds: [GROUP_ID],
              computedAtMillis: 1_000,
              waveGroupsVersion: '7'
            })
          )
        ),
        async (malformedPayload) => {
          mcache.clear();
          const redis = buildRedisMock();
          redis.get.mockImplementation((key: string) => {
            if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
              return Promise.resolve('7');
            }
            if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
              return Promise.resolve(malformedPayload);
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
        }
      ),
      { numRuns: 25 }
    );
  });

  it('collapses concurrent same-profile computations inside one process', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(buildRedisMock());
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

  /**
   * A Redis mock that keeps the catalogue blob, stamp and generation the way
   * the probe, publish and eviction scripts do.
   */
  function catalogueRedis() {
    const redis = buildRedisMock();
    const state = {
      blob: null as string | null,
      stamp: null as string | null,
      generation: '0',
      evict() {
        state.generation = String(Number(state.generation) + 1);
        state.blob = null;
        state.stamp = null;
      }
    };
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) return Promise.resolve('7');
      if (key === WAVE_GROUPS_CACHE_KEY) return Promise.resolve(state.blob);
      return Promise.resolve(null);
    });
    redis.eval.mockImplementation(
      (script: string, options?: { keys?: string[]; arguments?: string[] }) => {
        if (script.includes('STRLEN'))
          return Promise.resolve([
            state.blob ? Buffer.byteLength(state.blob, 'utf8') : 0,
            state.stamp,
            state.generation
          ]);
        if (
          options?.keys?.[1] === WAVE_GROUPS_CACHE_STAMP_KEY &&
          options.arguments
        ) {
          const [generation, payload, stamp] = options.arguments;
          if (generation !== state.generation) return Promise.resolve(0);
          state.blob = payload;
          state.stamp = stamp;
        }
        return Promise.resolve(1);
      }
    );
    return { redis, state };
  }

  it('reuses the in-memory catalogue while its stamp is current, without transferring the blob', async () => {
    const { redis } = catalogueRedis();
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    mcache.clear();
    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);

    expect(userGroupsDb.getByIds).toHaveBeenCalledTimes(1);
    expect(redis.get).not.toHaveBeenCalledWith(WAVE_GROUPS_CACHE_KEY);
  });

  it('never serves the in-memory catalogue after an explicit eviction: a new group is eligible at once', async () => {
    const { redis, state } = catalogueRedis();
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);
    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);

    // A wave is created with a new group the profile is listed in.
    userGroupsDb.getAllWaveRelatedGroups.mockResolvedValue([
      GROUP_ID,
      'new-group'
    ]);
    userGroupsDb.getByIds.mockResolvedValue([
      buildUserGroup(),
      buildUserGroup({ id: 'new-group', profile_group_id: 'profile-group-2' })
    ]);
    userGroupsDb.getGroupsUserIsEligibleByIdentity.mockResolvedValue([
      GROUP_ID,
      'new-group'
    ]);
    state.evict();
    mcache.clear();

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual(expect.arrayContaining([GROUP_ID, 'new-group']));
    expect(userGroupsDb.getByIds).toHaveBeenCalledTimes(2);
  });

  it('waits briefly for a Redis client that is still connecting before reading', async () => {
    const redis = { ...buildRedisMock(), isReady: false };
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    await buildService().getGroupsUserIsEligibleFor(PROFILE_ID);

    expect(waitForRedisReady).toHaveBeenCalledWith(300);
    expect(
      (waitForRedisReady as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(redis.get.mock.invocationCallOrder[0]);
  });

  it('does not wait for a ready Redis client', async () => {
    (getRedisClient as jest.Mock).mockReturnValue({
      ...buildRedisMock(),
      isReady: true
    });

    await buildService().getGroupsUserIsEligibleFor(PROFILE_ID);

    expect(waitForRedisReady).not.toHaveBeenCalled();
  });

  it('still fails closed when the client never becomes ready', async () => {
    (waitForRedisReady as jest.Mock).mockResolvedValueOnce(false);
    const redis = { ...buildRedisMock(), isReady: false };
    redis.get.mockRejectedValue(new Error('client is not connected'));
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    await expect(
      buildService().getGroupsUserIsEligibleFor(PROFILE_ID)
    ).rejects.toMatchObject({ status: 503 });
  });

  it('returns 503 on a production cache miss without Redis', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const userGroupsDb = buildUserGroupsDbMock();
    try {
      await expect(
        buildService(userGroupsDb).getGroupsUserIsEligibleFor(PROFILE_ID)
      ).rejects.toMatchObject({ status: 503 });
      expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('skips the wave-group id scan when the wave-group entity blob is warm', async () => {
    const waveGroup = buildUserGroup();
    const blob = JSON.stringify([waveGroup]);
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === WAVE_GROUPS_CACHE_KEY) {
        return Promise.resolve(blob);
      }
      return Promise.resolve(null);
    });
    answerCatalogueProbe(redis, blob);
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
    expect(userGroupsDb.getByIds).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalledWith(
      WAVE_GROUPS_CACHE_KEY,
      expect.anything(),
      expect.anything()
    );
  });

  it('scans wave-group ids and caches the entity blob when the blob is cold', async () => {
    const waveGroup = buildUserGroup();
    const redis = buildRedisMock();
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      return Promise.resolve(null);
    });
    answerCatalogueProbe(redis, null);
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    userGroupsDb.getAllWaveRelatedGroups.mockResolvedValue([GROUP_ID]);
    userGroupsDb.getByIds.mockResolvedValue([waveGroup]);
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
    expect(userGroupsDb.getByIds).toHaveBeenCalledWith(
      [GROUP_ID],
      expect.anything()
    );
    // One rebuild under the single-flight lease, published with its stamp
    // only under the generation it read before loading.
    expect(redis.set).toHaveBeenCalledWith(
      WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
      expect.any(String),
      { NX: true, PX: 10_000 }
    );
    const publish = redis.eval.mock.calls.find(
      ([, options]) =>
        (options as { keys?: string[] } | undefined)?.keys?.includes(
          WAVE_GROUPS_CACHE_STAMP_KEY
        ) && String(options?.arguments?.[1]).startsWith('[')
    );
    expect(publish?.[1]).toEqual({
      keys: [
        WAVE_GROUPS_CACHE_KEY,
        WAVE_GROUPS_CACHE_STAMP_KEY,
        WAVE_GROUPS_CACHE_GENERATION_KEY,
        WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY
      ],
      arguments: [
        '0',
        JSON.stringify([waveGroup]),
        expect.stringContaining('"generation":"0"'),
        '60',
        expect.any(String)
      ]
    });
  });

  it('polls every 25-50 ms for a peer result and validates only a published one', async () => {
    const sleeps: number[] = [];
    jest.spyOn(Time.prototype, 'sleep').mockImplementation(function (
      this: Time
    ) {
      sleeps.push(this.toMillis());
      return Promise.resolve();
    });
    const redis = buildRedisMock();
    let eligibleGroupsCacheReads = 0;
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        eligibleGroupsCacheReads++;
        // The first read is the initial cache check; the peer publishes
        // after three more polls.
        if (eligibleGroupsCacheReads <= 4) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: [GROUP_ID],
            computedAtMillis: 3_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    // A peer holds the lease throughout.
    redis.set.mockResolvedValue(null);
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(sleeps).toHaveLength(3);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThanOrEqual(50);
    }
    // Once for the initial check and once to validate the published result;
    // the empty polls never reach the database.
    expect(
      userGroupsDb.getLatestProfileGroupChangeMillis
    ).toHaveBeenCalledTimes(2);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
  });

  it('returns peer-produced cache entry without sleeping when it is already present', async () => {
    const sleepSpy = jest.spyOn(Time.prototype, 'sleep');
    const redis = buildRedisMock();
    let eligibleGroupsCacheReads = 0;
    redis.get.mockImplementation((key: string) => {
      if (key === WAVE_GROUPS_VERSION_CACHE_KEY) {
        return Promise.resolve('7');
      }
      if (key === ELIGIBLE_GROUPS_CACHE_KEY) {
        eligibleGroupsCacheReads++;
        if (eligibleGroupsCacheReads === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          JSON.stringify({
            eligibleGroupIds: [GROUP_ID],
            computedAtMillis: 3_000,
            waveGroupsVersion: 7
          })
        );
      }
      return Promise.resolve(null);
    });
    redis.set.mockResolvedValueOnce(null);
    (getRedisClient as jest.Mock).mockReturnValue(redis);

    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(eligibleGroupsCacheReads).toBe(2);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
  });
});

describe('UserGroupsService eligibility computation semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mcache.clear();
    (getRedisClient as jest.Mock).mockReturnValue(buildRedisMock());
  });

  it('keeps the sequential elimination semantics across all criteria types', async () => {
    // Sequential reference semantics: banned-by-identity split first, then
    // simple metrics -> total sent cic/rep -> ownings -> granular ratings ->
    // beneficiary grants; groups passing all checks come first, groups where
    // the user is in by identity are appended last.
    const tdhPass = buildUserGroup({
      id: 'tdh-pass',
      profile_group_id: null,
      tdh_min: 10
    });
    const tdhFail = buildUserGroup({
      id: 'tdh-fail',
      profile_group_id: null,
      tdh_min: 1000
    });
    const ownsPass = buildUserGroup({
      id: 'owns-pass',
      profile_group_id: null,
      owns_meme: true,
      owns_meme_tokens: JSON.stringify(['1'])
    });
    const ownsFail = buildUserGroup({
      id: 'owns-fail',
      profile_group_id: null,
      owns_meme: true,
      owns_meme_tokens: JSON.stringify(['999'])
    });
    const ownsAnyTokenPass = buildUserGroup({
      id: 'owns-any-token-pass',
      profile_group_id: null,
      owns_meme: true,
      owns_meme_tokens: JSON.stringify(['999', '1']),
      owns_meme_tokens_match_mode: GroupNftOwnershipMatchMode.ANY_TOKEN
    });
    const sentRepPass = buildUserGroup({
      id: 'sent-rep-pass',
      profile_group_id: null,
      rep_min: 5,
      rep_direction: FilterDirection.Sent
    });
    const sentRepFail = buildUserGroup({
      id: 'sent-rep-fail',
      profile_group_id: null,
      rep_min: 100,
      rep_direction: FilterDirection.Sent
    });
    const repByUserPass = buildUserGroup({
      id: 'rep-by-user-pass',
      profile_group_id: null,
      rep_min: 5,
      rep_user: 'rater-x'
    });
    const repByUserFail = buildUserGroup({
      id: 'rep-by-user-fail',
      profile_group_id: null,
      rep_min: 50,
      rep_user: 'rater-x'
    });
    const grantPass = buildUserGroup({
      id: 'grant-pass',
      profile_group_id: null,
      is_beneficiary_of_grant_id: 'grant-1'
    });
    const grantFail = buildUserGroup({
      id: 'grant-fail',
      profile_group_id: null,
      is_beneficiary_of_grant_id: 'grant-2',
      is_beneficiary_of_grant_match_mode:
        GroupBeneficiaryGrantMatchMode.ALL_TOKENS
    });
    const bannedGroup = buildUserGroup({
      id: 'banned-group',
      profile_group_id: null,
      excluded_profile_group_id: 'excluded-pg',
      tdh_min: 10
    });
    const byIdentityGroup = buildUserGroup({ id: 'by-identity-group' });
    const exclusionOnlyGroup = buildUserGroup({
      id: 'exclusion-only-group',
      profile_group_id: null,
      excluded_profile_group_id: 'excluded-pg-2'
    });
    const allGroups = [
      tdhPass,
      tdhFail,
      ownsPass,
      ownsFail,
      ownsAnyTokenPass,
      sentRepPass,
      sentRepFail,
      repByUserPass,
      repByUserFail,
      grantPass,
      grantFail,
      bannedGroup,
      byIdentityGroup,
      exclusionOnlyGroup
    ];

    const userGroupsDb = buildUserGroupsDbMock();
    userGroupsDb.getAllWaveRelatedGroups.mockResolvedValue(
      allGroups.map((it) => it.id)
    );
    userGroupsDb.getByIds.mockResolvedValue(allGroups);
    userGroupsDb.getIdentityByProfileId.mockResolvedValue({
      profile_id: PROFILE_ID,
      rep: 0,
      cic: 0,
      tdh: 50,
      xtdh: 0,
      level_raw: 0
    });
    userGroupsDb.getGroupsUserIsEligibleByIdentity.mockResolvedValue([
      byIdentityGroup.id
    ]);
    userGroupsDb.getGroupsUserIsExcludedFromByIdentity.mockResolvedValue([
      bannedGroup.id
    ]);
    userGroupsDb.getGivenCicAndRep.mockResolvedValue({ cic: 0, rep: 10 });
    userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract.mockResolvedValue(
      { [MEMES_CONTRACT.toLowerCase()]: ['1', '2'] }
    );
    userGroupsDb.getRatings.mockResolvedValue([
      {
        rater_profile_id: 'rater-x',
        matter_target_id: PROFILE_ID,
        matter: RateMatter.REP,
        matter_category: 'kindness',
        rating: 10
      }
    ]);
    userGroupsDb.findBeneficiaryGrantGroupIdsForProfile.mockResolvedValue([
      'grant-pass'
    ]);
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([
      'tdh-pass',
      'owns-pass',
      'owns-any-token-pass',
      'sent-rep-pass',
      'rep-by-user-pass',
      'grant-pass',
      'exclusion-only-group',
      'by-identity-group'
    ]);

    expect(userGroupsDb.getGivenCicAndRep).toHaveBeenCalledTimes(1);
    expect(userGroupsDb.getGivenCicAndRep).toHaveBeenCalledWith(PROFILE_ID);
    expect(
      userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract
    ).toHaveBeenCalledTimes(1);
    expect(
      userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract
    ).toHaveBeenCalledWith(PROFILE_ID, expect.anything());
    expect(userGroupsDb.getRatings).toHaveBeenCalledTimes(1);
    expect(userGroupsDb.getRatings).toHaveBeenCalledWith(
      PROFILE_ID,
      ['rater-x'],
      []
    );
    expect(
      userGroupsDb.findBeneficiaryGrantGroupIdsForProfile
    ).toHaveBeenCalledTimes(1);
    expect(
      userGroupsDb.findBeneficiaryGrantGroupIdsForProfile
    ).toHaveBeenCalledWith(
      {
        beneficiaryGrantGroups: [
          {
            groupId: 'grant-pass',
            grantId: 'grant-1',
            matchMode: GroupBeneficiaryGrantMatchMode.ANY_TOKEN
          },
          {
            groupId: 'grant-fail',
            grantId: 'grant-2',
            matchMode: GroupBeneficiaryGrantMatchMode.ALL_TOKENS
          }
        ],
        profileId: PROFILE_ID
      },
      expect.anything()
    );
  });

  it('skips conditional per-profile fetches when no candidate group needs them', async () => {
    const userGroupsDb = buildUserGroupsDbMock();
    const service = buildService(userGroupsDb);

    await expect(
      service.getGroupsUserIsEligibleFor(PROFILE_ID)
    ).resolves.toEqual([GROUP_ID]);
    expect(userGroupsDb.getGivenCicAndRep).not.toHaveBeenCalled();
    expect(
      userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract
    ).not.toHaveBeenCalled();
    expect(userGroupsDb.getRatings).not.toHaveBeenCalled();
    expect(
      userGroupsDb.findBeneficiaryGrantGroupIdsForProfile
    ).not.toHaveBeenCalled();
  });
});

describe('UserGroupsDb getAllProfileOwnedTokensByProfileIdGroupedByContract', () => {
  it('groups plain token rows by lowercased contract with token ids as lowercase strings', async () => {
    const execute = jest.fn().mockResolvedValue([
      { contract: '0xABC', token_id: 1 },
      { contract: '0xabc', token_id: 'TOKEN-2' },
      { contract: '0xDeF', token_id: 42 }
    ]);
    const db = new UserGroupsDb(() => ({ execute }) as unknown as SqlExecutor);

    const result =
      await db.getAllProfileOwnedTokensByProfileIdGroupedByContract(
        PROFILE_ID,
        {}
      );

    expect(result).toEqual({
      '0xabc': ['1', 'token-2'],
      '0xdef': ['42']
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql.toLowerCase()).not.toContain('group_concat');
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      { profileId: PROFILE_ID },
      { wrappedConnection: undefined }
    );
  });
});

describe('UserGroupsService draft membership SQL', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('binds included and excluded draft addresses without persisting a group', async () => {
    const service = buildService();
    const includedAddress = '0x1111111111111111111111111111111111111111';
    const excludedAddress = '0x2222222222222222222222222222222222222222';

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({
        identity_addresses: [includedAddress],
        excluded_identity_addresses: [excludedAddress]
      }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toContain(':preview_included_addresses');
    expect(result!.sql).toContain(':preview_excluded_addresses');
    expect(result!.sql).not.toContain('community_groups');
    expect(result!.params).toMatchObject({
      preview_included_addresses: [includedAddress],
      preview_excluded_addresses: [excludedAddress]
    });
    expect(result!.sql).toContain(
      'user_groups_view as (select i.* from identities i join included_profile_ids'
    );
  });

  it('uses a single anti-membership scan for an exclusion-only draft', async () => {
    const service = buildService();
    const excludedAddress = '0x2222222222222222222222222222222222222222';

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({
        excluded_identity_addresses: [excludedAddress]
      }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toContain(
      'select i.* from identities i where not exists'
    );
    expect(result!.sql).not.toContain('included_profile_ids as');
    expect(result!.params).toMatchObject({
      preview_excluded_addresses: [excludedAddress]
    });
  });

  it('returns an identity-shaped empty view for an empty draft', async () => {
    const service = buildService();

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup(),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toContain(
      'user_groups_view as (select * from cm_view where false)'
    );
    expect(result!.params).not.toHaveProperty('preview_included_addresses');
    expect(result!.params).not.toHaveProperty('preview_excluded_addresses');
  });

  it('binds draft NFT token criteria for all-token matching', async () => {
    const service = buildService();

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({
        owns_nfts: [
          {
            name: ApiGroupOwnsNftNameEnum.Memes,
            tokens: ['1', '2', '2'],
            match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS as never
          }
        ]
      }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toContain('token_id in (:meme_token_ids)');
    expect(result!.sql).toContain(':meme_token_ids_count');
    expect(result!.sql).not.toContain('JSON_TABLE');
    expect(result!.params).toMatchObject({
      meme_token_ids: ['1', '2'],
      meme_token_ids_count: 2
    });
  });

  it('binds draft NFT token criteria for any-token matching', async () => {
    const service = buildService();

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({
        owns_nfts: [
          {
            name: ApiGroupOwnsNftNameEnum.Memes,
            tokens: ['1', '2'],
            match_mode: GroupNftOwnershipMatchMode.ANY_TOKEN as never
          }
        ]
      }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toContain('token_id in (:meme_token_ids)');
    expect(result!.sql).not.toContain(':meme_token_ids_count');
    expect(result!.params).toMatchObject({ meme_token_ids: ['1', '2'] });
    expect(result!.params).not.toHaveProperty('meme_token_ids_count');
  });

  it('keeps zero as an explicit draft level boundary', async () => {
    const service = buildService();

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({ level: { min: 0, max: 0 } }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).not.toContain('i.level_raw >= :level_min');
    expect(result!.sql).toContain('i.level_raw < :level_max');
    expect(result!.sql).toContain('included_profile_ids');
    expect(result!.params).toEqual({ level_max: 25 });
  });

  it('separates NFT and beneficiary grant CTEs with valid delimiters', async () => {
    const service = buildService();
    const getGrantById = jest
      .spyOn(xTdhRepository, 'getGrantById')
      .mockResolvedValueOnce(buildGrant());

    const result = await service.getSqlAndParamsForPreview(
      buildPreviewGroup({
        owns_nfts: [
          {
            name: ApiGroupOwnsNftNameEnum.Memes,
            tokens: ['1'],
            match_mode: GroupNftOwnershipMatchMode.ANY_TOKEN as never
          }
        ],
        is_beneficiary_of_grant_id: 'grant-1'
      }),
      {}
    );

    expect(result).not.toBeNull();
    expect(result!.sql).toMatch(
      /meme_owners_of_group as[\s\S]*,\s*beneficiaries as[\s\S]*,\s*cm_view as/
    );
    expect(result!.sql).not.toMatch(/,\s*,/);
    expect(getGrantById).toHaveBeenCalledWith('grant-1', {});
  });

  it('rejects an unknown beneficiary grant before evaluating a draft', async () => {
    const service = buildService();
    const getGrantById = jest
      .spyOn(xTdhRepository, 'getGrantById')
      .mockResolvedValueOnce(null);

    await expect(
      service.getSqlAndParamsForPreview(
        buildPreviewGroup({ is_beneficiary_of_grant_id: 'missing-grant' }),
        {}
      )
    ).rejects.toThrow("Can't create group based on grant missing-grant");
    expect(getGrantById).toHaveBeenCalledWith('missing-grant', {});
  });
});
