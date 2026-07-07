import 'reflect-metadata';
import { anIdentity, withIdentities } from './fixtures/identity.fixture';
import { aUserGroup, withUserGroups } from './fixtures/user-group.fixture';
import { randomUUID } from 'node:crypto';
import {
  aProfileGroup,
  withProfileGroups
} from './fixtures/profile-group.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from './fixtures/wave.fixture';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { sqlExecutor } from '@/sql-executor';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { mock } from 'ts-jest-mocker';
import { IdentityEntity } from '@/entities/IIdentity';
import {
  GroupBeneficiaryGrantMatchMode,
  UserGroupEntity
} from '@/entities/IUserGroup';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  XTDH_STATS_META_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_GRANT_TOKENS_TABLE
} from '@/constants';
import { XTdhGrantStatus, XTdhGrantTokenMode } from '@/entities/IXTdhGrant';
import { Seed } from '@/tests/_setup/seed';

const tdh10Identity = anIdentity({ tdh: 10 });
const tdh20Identity = anIdentity({ tdh: 20 });

const tdh11Identity1 = anIdentity({ tdh: 11 });
const tdh11Identity2 = anIdentity({ tdh: 11 });
const partialGrantTokenOwner = anIdentity({ tdh: 12 });
const otherPartialGrantTokenOwner = anIdentity({ tdh: 13 });
const fullGrantTokenOwner = anIdentity({ tdh: 14 });

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
const pureProfileGroup = aUserGroup({
  profile_group_id: profileGroupWithTdh11Identity1.profile_group_id
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

const partialGrantId = randomUUID();
const partialGrantTokensetId = randomUUID();
const fullOwnerGrantId = randomUUID();
const fullOwnerGrantTokensetId = randomUUID();
const fullCollectionGrantId = randomUUID();
const fullCollectionGrantTokensetId = randomUUID();
const externalContract = '0x1111111111111111111111111111111111111111';
const externalPartition = `1:${externalContract}`;
const fullOwnerExternalContract = '0x2222222222222222222222222222222222222222';
const fullOwnerExternalPartition = `1:${fullOwnerExternalContract}`;

const partialGrantAnyGroup = aUserGroup({
  is_beneficiary_of_grant_id: partialGrantId,
  is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchMode.ANY_TOKEN
});
const partialGrantAllGroup = aUserGroup({
  is_beneficiary_of_grant_id: partialGrantId,
  is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchMode.ALL_TOKENS
});
const fullOwnerGrantAllGroup = aUserGroup({
  is_beneficiary_of_grant_id: fullOwnerGrantId,
  is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchMode.ALL_TOKENS
});
const invalidFullCollectionGrantAllGroup = aUserGroup({
  is_beneficiary_of_grant_id: fullCollectionGrantId,
  is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchMode.ALL_TOKENS
});

function withAddressConsolidationKeys(identities: IdentityEntity[]): Seed {
  return {
    table: ADDRESS_CONSOLIDATION_KEY,
    rows: identities.map((identity) => ({
      address: identity.primary_address,
      consolidation_key: identity.consolidation_key
    }))
  };
}

const withXtdhGrants: Seed = {
  table: XTDH_GRANTS_TABLE,
  rows: [
    {
      id: partialGrantId,
      tokenset_id: partialGrantTokensetId,
      replaced_grant_id: null,
      grantor_id: tdh10Identity.profile_id,
      target_chain: 1,
      target_contract: externalContract,
      target_partition: externalPartition,
      token_mode: XTdhGrantTokenMode.INCLUDE,
      created_at: 0,
      updated_at: 0,
      valid_from: 0,
      valid_to: null,
      rate: 1,
      status: XTdhGrantStatus.GRANTED,
      error_details: null,
      is_irrevocable: false
    },
    {
      id: fullOwnerGrantId,
      tokenset_id: fullOwnerGrantTokensetId,
      replaced_grant_id: null,
      grantor_id: tdh10Identity.profile_id,
      target_chain: 1,
      target_contract: fullOwnerExternalContract,
      target_partition: fullOwnerExternalPartition,
      token_mode: XTdhGrantTokenMode.INCLUDE,
      created_at: 0,
      updated_at: 0,
      valid_from: 0,
      valid_to: null,
      rate: 1,
      status: XTdhGrantStatus.GRANTED,
      error_details: null,
      is_irrevocable: false
    },
    {
      id: fullCollectionGrantId,
      tokenset_id: fullCollectionGrantTokensetId,
      replaced_grant_id: null,
      grantor_id: tdh10Identity.profile_id,
      target_chain: 1,
      target_contract: fullOwnerExternalContract,
      target_partition: fullOwnerExternalPartition,
      token_mode: XTdhGrantTokenMode.ALL,
      created_at: 0,
      updated_at: 0,
      valid_from: 0,
      valid_to: null,
      rate: 1,
      status: XTdhGrantStatus.GRANTED,
      error_details: null,
      is_irrevocable: false
    }
  ]
};

const withXtdhGrantTokens: Seed = {
  table: XTDH_GRANT_TOKENS_TABLE,
  rows: [
    {
      tokenset_id: partialGrantTokensetId,
      token_id: '1',
      target_partition: externalPartition
    },
    {
      tokenset_id: partialGrantTokensetId,
      token_id: '2',
      target_partition: externalPartition
    },
    {
      tokenset_id: fullOwnerGrantTokensetId,
      token_id: '10',
      target_partition: fullOwnerExternalPartition
    },
    {
      tokenset_id: fullOwnerGrantTokensetId,
      token_id: '11',
      target_partition: fullOwnerExternalPartition
    }
  ]
};

const withExternalOwnership: Seed = {
  table: EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  rows: [
    {
      partition: externalPartition,
      token_id: '1',
      owner: partialGrantTokenOwner.primary_address,
      since_block: 1,
      since_time: 1,
      sale_epoch_start_block: null,
      sale_epoch_tx: null,
      free_transfers_since_epoch: 0,
      created_at: 0,
      updated_at: 0
    },
    {
      partition: externalPartition,
      token_id: '2',
      owner: otherPartialGrantTokenOwner.primary_address,
      since_block: 1,
      since_time: 1,
      sale_epoch_start_block: null,
      sale_epoch_tx: null,
      free_transfers_since_epoch: 0,
      created_at: 0,
      updated_at: 0
    },
    {
      partition: fullOwnerExternalPartition,
      token_id: '10',
      owner: fullGrantTokenOwner.primary_address,
      since_block: 1,
      since_time: 1,
      sale_epoch_start_block: null,
      sale_epoch_tx: null,
      free_transfers_since_epoch: 0,
      created_at: 0,
      updated_at: 0
    },
    {
      partition: fullOwnerExternalPartition,
      token_id: '11',
      owner: fullGrantTokenOwner.primary_address,
      since_block: 1,
      since_time: 1,
      sale_epoch_start_block: null,
      sale_epoch_tx: null,
      free_transfers_since_epoch: 0,
      created_at: 0,
      updated_at: 0
    }
  ]
};

const withXtdhStatsMeta: Seed = {
  table: XTDH_STATS_META_TABLE,
  rows: [
    {
      id: 1,
      active_slot: 'a',
      as_of_midnight_ms: 0,
      last_updated_at: new Date(0)
    }
  ]
};

describe('smth', () => {
  it('s', () => {});
});

describeWithSeed(
  'UserGroupsIntegrationTests',
  [
    withIdentities([
      tdh10Identity,
      tdh20Identity,
      tdh11Identity1,
      tdh11Identity2,
      partialGrantTokenOwner,
      otherPartialGrantTokenOwner,
      fullGrantTokenOwner
    ]),
    withAddressConsolidationKeys([
      partialGrantTokenOwner,
      otherPartialGrantTokenOwner,
      fullGrantTokenOwner
    ]),
    withXtdhGrants,
    withXtdhGrantTokens,
    withExternalOwnership,
    withXtdhStatsMeta,
    withUserGroups([
      minTdh20Group,
      maxTdh10Group,
      tdhBetween15And25Group,
      pureProfileGroup,
      minTdh20AndTdh11Identity1Group,
      minTdh10AndTdh11Identity1ExcludedGroup,
      onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
      minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded,
      partialGrantAnyGroup,
      partialGrantAllGroup,
      fullOwnerGrantAllGroup,
      invalidFullCollectionGrantAllGroup
    ]),
    withWaves(
      [
        minTdh20Group,
        maxTdh10Group,
        tdhBetween15And25Group,
        pureProfileGroup,
        minTdh20AndTdh11Identity1Group,
        minTdh10AndTdh11Identity1ExcludedGroup,
        onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded,
        minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded,
        partialGrantAnyGroup,
        partialGrantAllGroup,
        fullOwnerGrantAllGroup,
        invalidFullCollectionGrantAllGroup
      ].map((it) => {
        return aWave({ visibility_group_id: it.id });
      })
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
          pureProfileGroup,
          minTdh20AndTdh11Identity1Group
        ]);
      });

      it('tdh11Identity2 gets its groups', async () => {
        await expectIdentityToBeInExactGroups(tdh11Identity2, [
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded
        ]);
      });

      it('grant token owner gets any-token grant group but not all-token grant group', async () => {
        await expectIdentityToBeInExactGroups(partialGrantTokenOwner, [
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded,
          partialGrantAnyGroup
        ]);
      });

      it('full grant token owner gets all-token grant group', async () => {
        await expectIdentityToBeInExactGroups(fullGrantTokenOwner, [
          minTdh10AndTdh11Identity1ExcludedGroup,
          minTdh10GroupWhereTdh11Identity1IsIncludedAndExcluded,
          fullOwnerGrantAllGroup
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

      it('identities of pureProfileGroup ', async () => {
        await expectGroupToContainExactIdentities(pureProfileGroup, [
          tdh11Identity1
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
          [
            tdh10Identity,
            tdh20Identity,
            tdh11Identity2,
            partialGrantTokenOwner,
            otherPartialGrantTokenOwner,
            fullGrantTokenOwner
          ]
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
          [
            tdh10Identity,
            tdh20Identity,
            tdh11Identity2,
            partialGrantTokenOwner,
            otherPartialGrantTokenOwner,
            fullGrantTokenOwner
          ]
        );
      });

      it('any-token grant group contains holders of any specified grant token', async () => {
        await expectGroupToContainExactIdentities(partialGrantAnyGroup, [
          partialGrantTokenOwner,
          otherPartialGrantTokenOwner
        ]);
      });

      it('all-token grant group excludes holders with only some grant tokens', async () => {
        await expectGroupToContainExactIdentities(partialGrantAllGroup, []);
      });

      it('all-token grant group contains holders with all specified grant tokens', async () => {
        await expectGroupToContainExactIdentities(fullOwnerGrantAllGroup, [
          fullGrantTokenOwner
        ]);
      });

      it('all-token match mode does not match full-collection grants', async () => {
        await expectGroupToContainExactIdentities(
          invalidFullCollectionGrantAllGroup,
          []
        );
      });
    });

    describe('is_pure_profile_group', () => {
      it('is computed from the stored criteria', async () => {
        const groups = await new UserGroupsDb(() => sqlExecutor).getByIds(
          [
            pureProfileGroup.id,
            minTdh20AndTdh11Identity1Group.id,
            onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded.id
          ],
          {}
        );
        const pureProfileGroupById = Object.fromEntries(
          groups.map((group) => [group.id, group.is_pure_profile_group])
        );

        expect(pureProfileGroupById[pureProfileGroup.id]).toBe(true);
        expect(pureProfileGroupById[minTdh20AndTdh11Identity1Group.id]).toBe(
          false
        );
        expect(
          pureProfileGroupById[
            onlyInclusionAndExclusionGroupWhereSameIdentityIsIncludedAndExcluded
              .id
          ]
        ).toBe(false);
      });
    });
  }
);
