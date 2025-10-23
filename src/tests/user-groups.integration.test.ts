import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import {
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '../constants';
import { UserGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { UserGroupsDb } from '../user-groups/user-groups.db';
import { mock } from 'ts-jest-mocker';
import { anIdentity } from './identity.fixture';
import { aUserGroup } from './user-group.fixture';
import { aWave } from './waves.fixture';
import { IdentityEntity } from '../entities/IIdentity';
import { UserGroupEntity } from '../entities/IUserGroup';
import { randomUUID } from 'node:crypto';
import { aProfileGroup } from './profile-group.fixture';

const tdh10Identity = anIdentity({ tdh: 10 });
const tdh20Identity = anIdentity({ tdh: 20 });
const minTdh20Group = aUserGroup({ tdh_min: 20 });
const maxTdh10Group = aUserGroup({ tdh_max: 10 });
const tdhBetween15And25Group = aUserGroup({ tdh_min: 15, tdh_max: 20 });

const tdh11Identity1 = anIdentity({ tdh: 11 });
const tdh11Identity2 = anIdentity({ tdh: 11 });

const profileGroupWithTdh11Identity1 = aProfileGroup({
  profile_group_id: randomUUID(),
  profile_id: tdh11Identity1.profile_id!
});

const profileGroupWithTdh11Identity2 = aProfileGroup({
  profile_group_id: randomUUID(),
  profile_id: tdh11Identity2.profile_id!
});

const minTdh20AndTdh11Identity1Group = aUserGroup({
  profile_group_id: profileGroupWithTdh11Identity1.profile_group_id,
  tdh_min: 20
});
const minTdh10AndTdh11Identity1ExcludedGroup = aUserGroup({
  excluded_profile_group_id: profileGroupWithTdh11Identity1.profile_group_id,
  tdh_min: 10
});
const onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded =
  aUserGroup({
    profile_group_id: profileGroupWithTdh11Identity1.profile_group_id,
    excluded_profile_group_id: profileGroupWithTdh11Identity1.profile_group_id
  });
const minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded = aUserGroup({
  profile_group_id: profileGroupWithTdh11Identity1.profile_group_id,
  excluded_profile_group_id: profileGroupWithTdh11Identity1.profile_group_id,
  tdh_min: 10
});

describeWithSeed(
  'UserGroupsIntegrationTests',
  [
    {
      table: IDENTITIES_TABLE,
      rows: [tdh10Identity, tdh20Identity, tdh11Identity1, tdh11Identity2]
    },
    {
      table: USER_GROUPS_TABLE,
      rows: [
        minTdh20Group,
        maxTdh10Group,
        tdhBetween15And25Group,
        minTdh20AndTdh11Identity1Group,
        minTdh10AndTdh11Identity1ExcludedGroup,
        onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
      ]
    },
    {
      table: WAVES_TABLE,
      rows: [
        aWave({
          visibility_group_id: minTdh20Group.id,
          admin_group_id: maxTdh10Group.id,
          chat_group_id: tdhBetween15And25Group.id
        }),
        aWave({
          visibility_group_id: minTdh20AndTdh11Identity1Group.id,
          admin_group_id: minTdh10AndTdh11Identity1ExcludedGroup.id,
          chat_group_id:
            onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded.id
        }),
        aWave({
          visibility_group_id:
            minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded.id
        })
      ]
    },
    {
      table: PROFILE_GROUPS_TABLE,
      rows: [profileGroupWithTdh11Identity1, profileGroupWithTdh11Identity2]
    }
  ],
  () => {
    const userGroupsService = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock()
    );

    async function expectIdentityToBeInExactGroups(
      identity: IdentityEntity,
      groups: UserGroupEntity[]
    ) {
      const groupsIdentityIsReallyIn = await userGroupsService
        .getGroupsUserIsEligibleFor(identity.profile_id)
        .then((res) => res.sort());
      const groupsIdentityIsExpectedToBeIn = groups.map((it) => it.id).sort();
      expect(groupsIdentityIsExpectedToBeIn).toEqual(groupsIdentityIsReallyIn);
    }

    it('tdh10Identity', async () => {
      await expectIdentityToBeInExactGroups(tdh10Identity, [
        maxTdh10Group,
        minTdh10AndTdh11Identity1ExcludedGroup,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
      ]);
    });

    it('tdh20Identity', async () => {
      await expectIdentityToBeInExactGroups(tdh20Identity, [
        minTdh20Group,
        tdhBetween15And25Group,
        minTdh20AndTdh11Identity1Group,
        minTdh10AndTdh11Identity1ExcludedGroup,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
      ]);
    });

    it('tdh11Identity1', async () => {
      await expectIdentityToBeInExactGroups(tdh11Identity1, [
        minTdh20AndTdh11Identity1Group
      ]);
    });

    it('tdh11Identity2', async () => {
      await expectIdentityToBeInExactGroups(tdh11Identity2, [
        minTdh10AndTdh11Identity1ExcludedGroup,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
      ]);
    });
  }
);
