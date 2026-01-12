import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { UserGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { UserGroupsDb } from '../user-groups/user-groups.db';
import { mock } from 'ts-jest-mocker';
import { anIdentity, withIdentities } from './fixtures/identity.fixture';
import { aUserGroup, withUserGroups } from './fixtures/user-group.fixture';
import { aWave, withWaves } from './fixtures/wave.fixture';
import { IdentityEntity } from '../entities/IIdentity';
import { UserGroupEntity } from '../entities/IUserGroup';
import { randomUUID } from 'node:crypto';
import {
  aProfileGroup,
  withProfileGroups
} from './fixtures/profile-group.fixture';

const tdh10Identity = anIdentity({ tdh: 10 });
const tdh20Identity = anIdentity({ tdh: 20 });

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

const minTdh20Group = aUserGroup({ tdh_min: 20 });
const maxTdh10Group = aUserGroup({ tdh_max: 10 });
const tdhBetween15And25Group = aUserGroup({ tdh_min: 15, tdh_max: 20 });

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
    withIdentities([
      tdh10Identity,
      tdh20Identity,
      tdh11Identity1,
      tdh11Identity2
    ]),
    withUserGroups([
      minTdh20Group,
      maxTdh10Group,
      tdhBetween15And25Group,
      minTdh20AndTdh11Identity1Group,
      minTdh10AndTdh11Identity1ExcludedGroup,
      onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
      minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
    ]),
    withWaves(
      [
        minTdh20Group,
        maxTdh10Group,
        tdhBetween15And25Group,
        minTdh20AndTdh11Identity1Group,
        minTdh10AndTdh11Identity1ExcludedGroup,
        onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
      ].map((it) => aWave({ visibility_group_id: it.id }))
    ),
    withProfileGroups([
      profileGroupWithTdh11Identity1,
      profileGroupWithTdh11Identity2
    ])
  ],
  () => {
    const userGroupsService = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock(),
      mock()
    );

    describe('identity is in groups', () => {
      async function expectIdentityToBeInExactGroups(
        identity: IdentityEntity,
        groups: UserGroupEntity[]
      ) {
        const groupsIdentityIsReallyIn = await userGroupsService
          .getGroupsUserIsEligibleFor(identity.profile_id)
          .then((res) => res.sort());
        const groupsIdentityIsExpectedToBeIn = groups.map((it) => it.id).sort();
        expect(groupsIdentityIsExpectedToBeIn).toEqual(
          groupsIdentityIsReallyIn
        );
      }

      it('tdh10Identity gets its groups', async () => {
        await expectIdentityToBeInExactGroups(tdh10Identity, [
          maxTdh10Group,
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
        ]);
      });

      it('tdh20Identity gets its groups', async () => {
        await expectIdentityToBeInExactGroups(tdh20Identity, [
          minTdh20Group,
          tdhBetween15And25Group,
          minTdh20AndTdh11Identity1Group,
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
        ]);
      });

      it('tdh11Identity1 gets its groups', async () => {
        await expectIdentityToBeInExactGroups(tdh11Identity1, [
          minTdh20AndTdh11Identity1Group
        ]);
      });

      it('tdh11Identity2 gets its groups', async () => {
        await expectIdentityToBeInExactGroups(tdh11Identity2, [
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
        ]);
      });
    });

    describe('group contains indentities', () => {
      async function expectGroupToContainExactIdentities(
        group: UserGroupEntity,
        identities: IdentityEntity[]
      ) {
        const viewResult = await userGroupsService.getSqlAndParamsByGroupId(
          group.id,
          {}
        );
        if (viewResult === null) {
          throw new Error(`missing viewResult`);
        }
        const identitiesReallyInTheGroup = await sqlExecutor
          .execute<{ profile_id: string }>(
            `
        ${viewResult.sql}
        select profile_id from ${UserGroupsService.GENERATED_VIEW}
      `,
            viewResult.params
          )
          .then((res) =>
            res
              .filter((it) => !!it)
              .map((it) => it.profile_id)
              .sort()
          );
        const identitiesExpectedInTheGroup = identities
          .map((it) => it.profile_id)
          .sort();
        expect(identitiesExpectedInTheGroup).toEqual(
          identitiesReallyInTheGroup
        );
      }

      it('identities of minTdh20Group ', async () => {
        await expectGroupToContainExactIdentities(minTdh20Group, [
          tdh20Identity
        ]);
      });

      it('identities of maxTdh10Group ', async () => {
        await expectGroupToContainExactIdentities(maxTdh10Group, [
          tdh10Identity
        ]);
      });

      it('identities of tdhBetween15And25Group ', async () => {
        await expectGroupToContainExactIdentities(tdhBetween15And25Group, [
          tdh20Identity
        ]);
      });

      it('identities of minTdh20AndTdh11Identity1Group ', async () => {
        await expectGroupToContainExactIdentities(
          minTdh20AndTdh11Identity1Group,
          [tdh20Identity, tdh11Identity1]
        );
      });

      it('identities of minTdh10AndTdh11Identity1ExcludedGroup ', async () => {
        await expectGroupToContainExactIdentities(
          minTdh10AndTdh11Identity1ExcludedGroup,
          [tdh10Identity, tdh20Identity, tdh11Identity2]
        );
      });
      it('identities of minTdh10AndTdh11Identity1ExcludedGroup ', async () => {
        await expectGroupToContainExactIdentities(
          onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
          []
        );
      });

      it('identities of minTdh10AndTdh11Identity1ExcludedGroup ', async () => {
        await expectGroupToContainExactIdentities(
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded,
          [tdh10Identity, tdh20Identity, tdh11Identity2]
        );
      });
    });
  }
);
