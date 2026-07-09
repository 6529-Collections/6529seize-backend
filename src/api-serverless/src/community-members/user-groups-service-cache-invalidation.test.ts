import { NewUserGroupEntity, UserGroupsService } from './user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '@/entities/IUserGroup';
import {
  clearWaveGroupsCache,
  evictWaveGroupsEntityCache,
  getRedisClient
} from '@/redis';
import { AbusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { ApiGroupBeneficiaryGrantMatchMode } from '@/api/generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { ApiGroupTdhInclusionStrategy } from '@/api/generated/models/ApiGroupTdhInclusionStrategy';
import { RequestContext } from '@/request.context';
import * as mcache from 'memory-cache';

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn(),
  clearWaveGroupsCache: jest.fn(),
  evictWaveGroupsEntityCache: jest.fn()
}));

const CREATOR_ID = 'creator-profile-1';
const GROUP_ID = 'group-1';
const OLD_GROUP_ID = 'group-0';
const IDENTITY_GROUP_ID = 'identity-group-1';

type NewGroupInput = Omit<
  NewUserGroupEntity,
  'profile_group_id' | 'excluded_profile_group_id'
> & {
  addresses: string[];
  excluded_addresses: string[];
};

function aNewGroup(overrides: Partial<NewGroupInput> = {}): NewGroupInput {
  return {
    name: 'Test Group',
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
    visible: true,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null,
    is_beneficiary_of_grant_match_mode:
      GroupBeneficiaryGrantMatchMode.ANY_TOKEN,
    addresses: ['0x1', '0x2'],
    excluded_addresses: [],
    ...overrides
  };
}

function aGroupEntity(
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
    created_by: CREATOR_ID,
    visible: true,
    owns_meme: false,
    owns_meme_tokens: null,
    owns_gradient: false,
    owns_gradient_tokens: null,
    owns_nextgen: false,
    owns_nextgen_tokens: null,
    owns_lab: false,
    owns_lab_tokens: null,
    profile_group_id: IDENTITY_GROUP_ID,
    excluded_profile_group_id: null,
    is_pure_profile_group: true,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null,
    ...overrides
  } as UserGroupEntity;
}

function anApiGroupFull(
  groupOverrides: Partial<ApiGroupFull['group']> = {},
  overrides: Partial<ApiGroupFull> = {}
): ApiGroupFull {
  return {
    id: GROUP_ID,
    name: 'Group 1',
    visible: true,
    is_private: false,
    created_at: 1_000,
    created_by: { id: CREATOR_ID } as unknown as ApiGroupFull['created_by'],
    group: {
      cic: { min: null, max: null, direction: null, user_identity: null },
      rep: {
        min: null,
        max: null,
        direction: null,
        user_identity: null,
        category: null
      },
      level: { min: null, max: null },
      tdh: {
        min: null,
        max: null,
        inclusion_strategy: ApiGroupTdhInclusionStrategy.Tdh
      },
      owns_nfts: [],
      identity_group_id: IDENTITY_GROUP_ID,
      identity_group_identities_count: 2,
      excluded_identity_group_id: null,
      excluded_identity_group_identities_count: 0,
      is_beneficiary_of_grant_id: null,
      is_beneficiary_of_grant_match_mode:
        ApiGroupBeneficiaryGrantMatchMode.AnyToken,
      is_beneficiary_of_grant: null,
      ...groupOverrides
    },
    ...overrides
  };
}

function buildUserGroupsDbMock() {
  return {
    executeNativeQueriesInTransaction: jest
      .fn()
      .mockImplementation(async (callback: any) => callback({})),
    insertGroupEntriesAndGetGroupIds: jest
      .fn()
      .mockResolvedValue({ profile_group_id: IDENTITY_GROUP_ID }),
    save: jest.fn().mockResolvedValue(undefined),
    deleteById: jest.fn().mockResolvedValue(undefined),
    changeVisibilityAndSetId: jest.fn().mockResolvedValue(undefined),
    getByIds: jest.fn().mockResolvedValue([]),
    findUserGroupsIdentityGroupProfileIds: jest.fn().mockResolvedValue({}),
    insertGroupChanges: jest.fn().mockResolvedValue(undefined)
  };
}

type UserGroupsDbMock = ReturnType<typeof buildUserGroupsDbMock>;

function buildService(userGroupsDb: UserGroupsDbMock) {
  return new UserGroupsService(
    userGroupsDb as unknown as UserGroupsDb,
    {
      checkFilterName: jest.fn().mockResolvedValue({ status: 'ALLOWED' })
    } as unknown as AbusivenessCheckService,
    {
      recordActiveIdentity: jest.fn().mockResolvedValue(undefined)
    } as unknown as MetricsRecorder
  );
}

function buildRedisMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1)
  };
}

const ctx: RequestContext = { timer: undefined };

describe('UserGroupsService eligibility cache invalidation scoping', () => {
  let redis: ReturnType<typeof buildRedisMock>;

  beforeAll(() => {
    process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE = '0';
  });

  afterAll(() => {
    delete process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mcache.clear();
    redis = buildRedisMock();
    (getRedisClient as jest.Mock).mockReturnValue(redis);
  });

  describe('save', () => {
    async function saveGroup(group: NewGroupInput) {
      const userGroupsDb = buildUserGroupsDbMock();
      const service = buildService(userGroupsDb);
      jest.spyOn(service, 'getByIdOrThrow').mockResolvedValue(anApiGroupFull());
      await service.save(group, CREATOR_ID, ctx);
      return userGroupsDb;
    }

    it('skips the global version bump for a pure inclusion-list group but evicts the blob and invalidates the creator', async () => {
      await saveGroup(aNewGroup());
      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
      expect(redis.del).toHaveBeenCalledWith(
        `cache_6529_eligible_groups:${CREATOR_ID}`
      );
    });

    it('skips the global version bump for an inclusion-list group with exclusions and no criteria', async () => {
      await saveGroup(aNewGroup({ excluded_addresses: ['0x3'] }));
      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
    });

    it('bumps the global version for a group with non-identity criteria', async () => {
      await saveGroup(aNewGroup({ tdh_min: 10 }));
      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(
        `cache_6529_eligible_groups:${CREATOR_ID}`
      );
    });

    it('bumps the global version for an exclusions-only group without an inclusion list', async () => {
      await saveGroup(
        aNewGroup({ addresses: [], excluded_addresses: ['0x3'] })
      );
      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
    });
  });

  describe('changeVisibility', () => {
    it('bumps only the members of a pure inclusion-list group instead of the global version', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.findUserGroupsIdentityGroupProfileIds.mockResolvedValue({
        [IDENTITY_GROUP_ID]: ['member-1', 'member-2']
      });
      const service = buildService(userGroupsDb);
      jest.spyOn(service, 'getByIdOrThrow').mockResolvedValue(anApiGroupFull());

      await service.changeVisibility(
        {
          group_id: GROUP_ID,
          old_version_id: null,
          visible: true,
          profile_id: CREATOR_ID
        },
        ctx
      );

      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
      expect(
        userGroupsDb.findUserGroupsIdentityGroupProfileIds
      ).toHaveBeenCalledWith([IDENTITY_GROUP_ID]);
      expect(userGroupsDb.insertGroupChanges).toHaveBeenCalledWith([
        'member-1',
        'member-2'
      ]);
    });

    it('bumps the global version for a group with non-identity criteria', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      const service = buildService(userGroupsDb);
      jest.spyOn(service, 'getByIdOrThrow').mockResolvedValue(
        anApiGroupFull({
          tdh: {
            min: 10,
            max: null,
            inclusion_strategy: ApiGroupTdhInclusionStrategy.Tdh
          }
        })
      );

      await service.changeVisibility(
        {
          group_id: GROUP_ID,
          old_version_id: null,
          visible: true,
          profile_id: CREATOR_ID
        },
        ctx
      );

      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
      expect(userGroupsDb.insertGroupChanges).not.toHaveBeenCalled();
    });

    it('bumps members of both new and replaced pure list groups when publishing a new version', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.findUserGroupsIdentityGroupProfileIds.mockResolvedValue({
        'identity-group-new': ['member-1', 'member-2'],
        'identity-group-old': ['member-2', 'member-3']
      });
      const service = buildService(userGroupsDb);
      const newGroupInitial = anApiGroupFull({
        identity_group_id: 'identity-group-new'
      });
      const oldGroup = anApiGroupFull(
        { identity_group_id: 'identity-group-old' },
        { id: OLD_GROUP_ID }
      );
      const updatedGroupAfterSwap = anApiGroupFull(
        { identity_group_id: 'identity-group-new' },
        { id: OLD_GROUP_ID }
      );
      jest
        .spyOn(service, 'getByIdOrThrow')
        .mockResolvedValueOnce(newGroupInitial)
        .mockResolvedValueOnce(oldGroup)
        .mockResolvedValueOnce(updatedGroupAfterSwap);

      await service.changeVisibility(
        {
          group_id: GROUP_ID,
          old_version_id: OLD_GROUP_ID,
          visible: true,
          profile_id: CREATOR_ID
        },
        ctx
      );

      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
      expect(
        userGroupsDb.findUserGroupsIdentityGroupProfileIds
      ).toHaveBeenCalledWith(['identity-group-new', 'identity-group-old']);
      expect(userGroupsDb.insertGroupChanges).toHaveBeenCalledWith([
        'member-1',
        'member-2',
        'member-3'
      ]);
    });
  });

  describe('onWaveRelatedGroupsChanged', () => {
    it('only evicts the entity blob when no group ids are given', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      const service = buildService(userGroupsDb);

      await service.onWaveRelatedGroupsChanged([null, undefined], ctx);

      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(userGroupsDb.getByIds).not.toHaveBeenCalled();
      expect(userGroupsDb.insertGroupChanges).not.toHaveBeenCalled();
    });

    it('bumps only the distinct members when all groups are pure inclusion-list groups', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.getByIds.mockResolvedValue([
        aGroupEntity({ id: 'group-a', profile_group_id: 'identity-group-a' }),
        aGroupEntity({ id: 'group-b', profile_group_id: 'identity-group-b' })
      ]);
      userGroupsDb.findUserGroupsIdentityGroupProfileIds.mockResolvedValue({
        'identity-group-a': ['member-1', 'member-2'],
        'identity-group-b': ['member-2', 'member-3']
      });
      const service = buildService(userGroupsDb);

      await service.onWaveRelatedGroupsChanged(
        ['group-a', 'group-b', 'group-a', null, undefined],
        ctx
      );

      expect(clearWaveGroupsCache).not.toHaveBeenCalled();
      expect(evictWaveGroupsEntityCache).toHaveBeenCalledTimes(1);
      expect(userGroupsDb.getByIds).toHaveBeenCalledWith(
        ['group-a', 'group-b'],
        ctx
      );
      expect(
        userGroupsDb.findUserGroupsIdentityGroupProfileIds
      ).toHaveBeenCalledWith(['identity-group-a', 'identity-group-b']);
      expect(userGroupsDb.insertGroupChanges).toHaveBeenCalledWith([
        'member-1',
        'member-2',
        'member-3'
      ]);
    });

    it('bumps the global version when any group has non-identity criteria', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.getByIds.mockResolvedValue([
        aGroupEntity({ id: 'group-a', profile_group_id: 'identity-group-a' }),
        aGroupEntity({
          id: 'group-b',
          profile_group_id: 'identity-group-b',
          tdh_min: 5
        })
      ]);
      const service = buildService(userGroupsDb);

      await service.onWaveRelatedGroupsChanged(['group-a', 'group-b'], ctx);

      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
      expect(userGroupsDb.insertGroupChanges).not.toHaveBeenCalled();
    });

    it('bumps the global version when any group has no inclusion list', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.getByIds.mockResolvedValue([
        aGroupEntity({ id: 'group-a', profile_group_id: 'identity-group-a' }),
        aGroupEntity({
          id: 'group-b',
          profile_group_id: null,
          excluded_profile_group_id: 'identity-group-x'
        })
      ]);
      const service = buildService(userGroupsDb);

      await service.onWaveRelatedGroupsChanged(['group-a', 'group-b'], ctx);

      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
      expect(userGroupsDb.insertGroupChanges).not.toHaveBeenCalled();
    });

    it('bumps the global version when any group id cannot be loaded', async () => {
      const userGroupsDb = buildUserGroupsDbMock();
      userGroupsDb.getByIds.mockResolvedValue([
        aGroupEntity({ id: 'group-a', profile_group_id: 'identity-group-a' })
      ]);
      const service = buildService(userGroupsDb);

      await service.onWaveRelatedGroupsChanged(['group-a', 'group-gone'], ctx);

      expect(clearWaveGroupsCache).toHaveBeenCalledTimes(1);
      expect(evictWaveGroupsEntityCache).not.toHaveBeenCalled();
      expect(userGroupsDb.insertGroupChanges).not.toHaveBeenCalled();
    });
  });
});
