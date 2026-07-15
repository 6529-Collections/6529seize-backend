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
