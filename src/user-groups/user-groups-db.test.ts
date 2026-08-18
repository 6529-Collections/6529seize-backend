import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { UserGroupsDb } from './user-groups.db';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import {
  aProfileGroup,
  withProfileGroups
} from '@/tests/fixtures/profile-group.fixture';

const pureProfileGroup = aUserGroup(
  {
    profile_group_id: randomUUID(),
    is_direct_message: false
  },
  {
    id: 'pure-profile-group',
    name: 'Search Group Profile'
  }
);

const criteriaGroup = aUserGroup(
  {
    tdh_min: 1,
    is_direct_message: false
  },
  {
    id: 'criteria-group',
    name: 'Search Group Criteria'
  }
);

const unrelatedGroup = aUserGroup(
  {
    is_direct_message: false
  },
  {
    id: 'unrelated-group',
    name: 'Another Group'
  }
);

describeWithSeed(
  'UserGroupsDb searchByNameOrAuthor',
  withUserGroups([pureProfileGroup, criteriaGroup, unrelatedGroup]),
  () => {
    const repo = new UserGroupsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('excludes pure profile groups when includeProfileGroups is false', async () => {
      const results = await repo.searchByNameOrAuthor(
        'Search Group',
        null,
        null,
        false,
        null,
        [],
        ctx
      );

      expect(results.map((group) => group.id).sort()).toEqual([
        criteriaGroup.id
      ]);
    });

    it('includes pure profile groups when includeProfileGroups is true', async () => {
      const results = await repo.searchByNameOrAuthor(
        'Search Group',
        null,
        null,
        true,
        null,
        [],
        ctx
      );

      expect(results.map((group) => group.id).sort()).toEqual(
        [criteriaGroup.id, pureProfileGroup.id].sort()
      );
    });
  }
);

const membershipProfileGroupId = randomUUID();
const membershipGroup = aUserGroup(
  {
    profile_group_id: membershipProfileGroupId,
    is_direct_message: false
  },
  {
    id: 'membership-group',
    name: 'Membership Group'
  }
);
const candidateMembership = aProfileGroup({
  profile_group_id: membershipProfileGroupId,
  profile_id: 'candidate-profile'
});
const unrelatedMembership = aProfileGroup({
  profile_group_id: membershipProfileGroupId,
  profile_id: 'unrelated-profile'
});

describeWithSeed(
  'UserGroupsDb findIdentityGroupMemberships',
  [
    withUserGroups([membershipGroup]),
    withProfileGroups([candidateMembership, unrelatedMembership])
  ],
  () => {
    const repo = new UserGroupsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('limits membership rows to the supplied recipient candidates', async () => {
      await expect(
        repo.findIdentityGroupMemberships(
          {
            groupIds: [membershipGroup.id],
            profileIds: ['candidate-profile', 'missing-profile']
          },
          ctx
        )
      ).resolves.toEqual([
        {
          groupId: membershipGroup.id,
          profileId: 'candidate-profile'
        }
      ]);
    });

    it('returns no rows without querying for an empty candidate set', async () => {
      await expect(
        repo.findIdentityGroupMemberships(
          { groupIds: [membershipGroup.id], profileIds: [] },
          ctx
        )
      ).resolves.toEqual([]);
    });

    it('returns complete group membership through the bounded page API', async () => {
      await expect(
        repo.findIdentityGroupMembershipPage(
          {
            groupIds: [membershipGroup.id],
            after: null
          },
          ctx
        )
      ).resolves.toEqual({
        memberships: [
          {
            groupId: membershipGroup.id,
            profileId: 'candidate-profile'
          },
          {
            groupId: membershipGroup.id,
            profileId: 'unrelated-profile'
          }
        ],
        nextCursor: null
      });
    });
  }
);

describe('UserGroupsDb findIdentityGroupMemberships batching', () => {
  it('queries distinct profile ids in bounded batches', async () => {
    const execute = jest
      .fn()
      .mockImplementation(
        async (
          _sql: string,
          params: { groupIds: string[]; profileIds: string[] }
        ) =>
          params.profileIds.map((profileId) => ({
            group_id: params.groupIds[0],
            profile_id: profileId
          }))
      );
    const repo = new UserGroupsDb(() => ({ execute }) as never);
    const distinctProfileIds = Array.from(
      { length: 501 },
      (_, index) => `profile-${index}`
    );

    await expect(
      repo.findIdentityGroupMemberships(
        {
          groupIds: ['group-1'],
          profileIds: [...distinctProfileIds, distinctProfileIds[0]]
        },
        { timer: undefined }
      )
    ).resolves.toHaveLength(501);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toEqual({
      groupIds: ['group-1'],
      profileIds: distinctProfileIds.slice(0, 500)
    });
    expect(execute.mock.calls[1][1]).toEqual({
      groupIds: ['group-1'],
      profileIds: distinctProfileIds.slice(500)
    });
  });
});

const firstPaginationProfileGroupId = randomUUID();
const secondPaginationProfileGroupId = randomUUID();
const firstPaginationGroup = aUserGroup(
  {
    profile_group_id: firstPaginationProfileGroupId,
    is_direct_message: false
  },
  {
    id: 'pagination-group-a',
    name: 'Pagination Group A'
  }
);
const secondPaginationGroup = aUserGroup(
  {
    profile_group_id: secondPaginationProfileGroupId,
    is_direct_message: false
  },
  {
    id: 'pagination-group-b',
    name: 'Pagination Group B'
  }
);
const firstPaginationGroupMemberships = Array.from(
  { length: 500 },
  (_, index) =>
    aProfileGroup({
      profile_group_id: firstPaginationProfileGroupId,
      profile_id: `pagination-profile-${index.toString().padStart(3, '0')}`
    })
);
const secondPaginationGroupMembership = aProfileGroup({
  profile_group_id: secondPaginationProfileGroupId,
  profile_id: 'pagination-profile-000'
});

describeWithSeed(
  'UserGroupsDb findIdentityGroupMembershipPage database pagination',
  [
    withUserGroups([firstPaginationGroup, secondPaginationGroup]),
    withProfileGroups([
      ...firstPaginationGroupMemberships,
      secondPaginationGroupMembership
    ])
  ],
  () => {
    const repo = new UserGroupsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('continues across a group boundary after a full database page', async () => {
      const firstPage = await repo.findIdentityGroupMembershipPage(
        {
          groupIds: [firstPaginationGroup.id, secondPaginationGroup.id],
          after: null
        },
        ctx
      );

      expect(firstPage.memberships).toHaveLength(500);
      expect(firstPage.memberships[0]).toEqual({
        groupId: firstPaginationGroup.id,
        profileId: 'pagination-profile-000'
      });
      expect(firstPage.nextCursor).toEqual({
        groupId: firstPaginationGroup.id,
        profileId: 'pagination-profile-499'
      });

      await expect(
        repo.findIdentityGroupMembershipPage(
          {
            groupIds: [firstPaginationGroup.id, secondPaginationGroup.id],
            after: firstPage.nextCursor
          },
          ctx
        )
      ).resolves.toEqual({
        memberships: [
          {
            groupId: secondPaginationGroup.id,
            profileId: secondPaginationGroupMembership.profile_id
          }
        ],
        nextCursor: null
      });
    });
  }
);

describe('UserGroupsDb findIdentityGroupMembershipPage', () => {
  it('bounds each query and returns a stable continuation cursor', async () => {
    const firstGroupRows = Array.from({ length: 500 }, (_, index) => ({
      group_id: 'group-1',
      profile_id: `profile-${index.toString().padStart(3, '0')}`
    }));
    const firstRowInSecondGroup = {
      group_id: 'group-2',
      profile_id: 'profile-000'
    };
    const executor = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([...firstGroupRows, firstRowInSecondGroup])
        .mockResolvedValueOnce([firstRowInSecondGroup])
    };
    const repo = new UserGroupsDb(() => executor as never);

    const page = await repo.findIdentityGroupMembershipPage(
      {
        groupIds: ['group-1', 'group-2'],
        after: null
      },
      { timer: undefined }
    );

    expect(page.memberships).toHaveLength(500);
    expect(page.nextCursor).toEqual({
      groupId: 'group-1',
      profileId: 'profile-499'
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT :limit'),
      { groupIds: ['group-1', 'group-2'], limit: 501 },
      { wrappedConnection: undefined }
    );

    await expect(
      repo.findIdentityGroupMembershipPage(
        {
          groupIds: ['group-1', 'group-2'],
          after: page.nextCursor
        },
        { timer: undefined }
      )
    ).resolves.toEqual({
      memberships: [{ groupId: 'group-2', profileId: 'profile-000' }],
      nextCursor: null
    });
    expect(executor.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ug.id > :afterGroupId'),
      {
        groupIds: ['group-1', 'group-2'],
        afterGroupId: 'group-1',
        afterProfileId: 'profile-499',
        limit: 501
      },
      { wrappedConnection: undefined }
    );
  });
});

describeWithSeed(
  'UserGroupsDb findMembershipKeysOutsideContainingGroup',
  [],
  () => {
    const repo = new UserGroupsDb(() => sqlExecutor);
    const membershipSql = (key: string, profileIds: readonly string[]) => ({
      key,
      sql: `with harmless_literal as (
              select ':not_a_parameter' as marker
            ),
            shared_membership_stage as (
              ${profileIds
                .map(
                  (_profileId, index) =>
                    `select :profile_${index} as profile_id`
                )
                .join(' union all ')}),
             user_groups_view as (
               select profile_id from shared_membership_stage
             )`,
      params: Object.fromEntries(
        profileIds.map((profileId, index) => [`profile_${index}`, profileId])
      )
    });

    it('finds every group with a member outside the containing group in one query', async () => {
      await expect(
        repo.findMembershipKeysOutsideContainingGroup(
          membershipSql('view', ['profile-1', 'profile-2']),
          [
            membershipSql('contained', ['profile-1']),
            membershipSql('outside', ['profile-3']),
            membershipSql('mixed', ['profile-2', 'profile-4'])
          ],
          { timer: undefined }
        )
      ).resolves.toEqual(expect.arrayContaining(['outside', 'mixed']));
    });
  }
);

describe('UserGroupsDb membership SQL parameter validation', () => {
  it('drops unused generated parameters while preserving referenced bindings', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new UserGroupsDb(() => ({ execute }) as any);
    const identityGroupMembership = (key: string, profileGroupId: string) => ({
      key,
      sql: `with included_profile_ids as (
              select profile_id from profile_groups
               where profile_group_id = :profile_group_id
            ),
            user_groups_view as (
              select profile_id from included_profile_ids
            )`,
      params: {
        profile_group_id: profileGroupId,
        excluded_profile_group_id: null
      }
    });

    await expect(
      repo.findMembershipKeysOutsideContainingGroup(
        identityGroupMembership('view', 'view-profile-group'),
        [identityGroupMembership('chat', 'chat-profile-group')],
        { timer: undefined }
      )
    ).resolves.toEqual([]);

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(':containing_profile_group_id'),
      {
        containing_profile_group_id: 'view-profile-group',
        contained_0_key: 'chat',
        contained_0_profile_group_id: 'chat-profile-group'
      },
      undefined
    );
  });

  it('fails closed before executing SQL with an unbound placeholder', async () => {
    const execute = jest.fn();
    const repo = new UserGroupsDb(() => ({ execute }) as any);

    await expect(
      repo.findMembershipKeysOutsideContainingGroup(
        {
          key: 'view',
          sql: 'with user_groups_view as (select :missing as profile_id)',
          params: {}
        },
        [
          {
            key: 'contained',
            sql: 'with user_groups_view as (select :profile as profile_id)',
            params: { profile: 'profile-1' }
          }
        ],
        { timer: undefined }
      )
    ).rejects.toThrow('contains an unbound parameter');
    expect(execute).not.toHaveBeenCalled();
  });
});
