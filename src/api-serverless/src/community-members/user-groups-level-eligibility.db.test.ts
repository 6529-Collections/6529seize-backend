import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import { randomUUID } from 'node:crypto';
import { UserGroupsService } from './user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import {
  aProfileGroup,
  withProfileGroups
} from '@/tests/fixtures/profile-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { IdentityEntity } from '@/entities/IIdentity';
import { UserGroupEntity } from '@/entities/IUserGroup';

const negativeScore = anIdentity({ rep: -10, level_raw: -10 });
const zeroScore = anIdentity({ level_raw: 0 });
const levelZeroCeiling = anIdentity({ tdh: 24, level_raw: 24 });
const levelOneFromXtdh = anIdentity({ xtdh: 25, level_raw: 25 });
const levelOneCeiling = anIdentity({ tdh: 49, level_raw: 49 });
const levelTwoFloor = anIdentity({ tdh: 50, level_raw: 50 });
const levelHundredFloor = anIdentity({
  tdh: 25_000_000,
  level_raw: 25_000_000
});
const aboveLevelHundredFloor = anIdentity({
  tdh: 30_000_000,
  level_raw: 30_000_000
});

const identities = [
  negativeScore,
  zeroScore,
  levelZeroCeiling,
  levelOneFromXtdh,
  levelOneCeiling,
  levelTwoFloor,
  levelHundredFloor,
  aboveLevelHundredFloor
];

const levelZeroOnly = aUserGroup({ level_min: 0, level_max: 0 });
const levelOneOnly = aUserGroup({ level_min: 1, level_max: 1 });
const atLeastLevelOne = aUserGroup({ level_min: 1 });
const atMostLevelOne = aUserGroup({ level_max: 1 });
const levelHundredOnly = aUserGroup({ level_min: 100, level_max: 100 });
const fullLevelRange = aUserGroup({ level_min: 0, level_max: 100 });
const negativeLevelRange = aUserGroup({ level_min: -10, level_max: -1 });

const includedProfileGroupId = randomUUID();
const excludedProfileGroupId = randomUUID();
const levelOneWithOverrides = aUserGroup({
  level_min: 1,
  level_max: 1,
  profile_group_id: includedProfileGroupId,
  excluded_profile_group_id: excludedProfileGroupId
});

const groups = [
  levelZeroOnly,
  levelOneOnly,
  atLeastLevelOne,
  atMostLevelOne,
  levelHundredOnly,
  fullLevelRange,
  negativeLevelRange,
  levelOneWithOverrides
];

const expectedMembers = new Map<UserGroupEntity, IdentityEntity[]>([
  [levelZeroOnly, [negativeScore, zeroScore, levelZeroCeiling]],
  [levelOneOnly, [levelOneFromXtdh, levelOneCeiling]],
  [
    atLeastLevelOne,
    [
      levelOneFromXtdh,
      levelOneCeiling,
      levelTwoFloor,
      levelHundredFloor,
      aboveLevelHundredFloor
    ]
  ],
  [
    atMostLevelOne,
    [
      negativeScore,
      zeroScore,
      levelZeroCeiling,
      levelOneFromXtdh,
      levelOneCeiling
    ]
  ],
  [levelHundredOnly, [levelHundredFloor, aboveLevelHundredFloor]],
  [fullLevelRange, identities],
  [negativeLevelRange, []],
  [levelOneWithOverrides, [negativeScore, levelOneFromXtdh]]
]);

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describeWithSeed(
  'User group level eligibility',
  [
    withIdentities(identities),
    withUserGroups(groups),
    withProfileGroups([
      aProfileGroup({
        profile_group_id: includedProfileGroupId,
        profile_id: negativeScore.profile_id!
      }),
      aProfileGroup({
        profile_group_id: excludedProfileGroupId,
        profile_id: levelOneCeiling.profile_id!
      })
    ]),
    withWaves(groups.map((group) => aWave({ visibility_group_id: group.id })))
  ],
  () => {
    const service = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock(),
      mock()
    );

    it('uses ordinal levels for cached authorization across score boundaries', async () => {
      for (const identity of identities) {
        const expectedGroupIds = groups
          .filter((group) => expectedMembers.get(group)!.includes(identity))
          .map((group) => group.id);

        const computedGroupIds = await service.getGroupsUserIsEligibleFor(
          identity.profile_id
        );
        const cachedGroupIds = await service.getGroupsUserIsEligibleFor(
          identity.profile_id
        );

        expect(sorted(computedGroupIds)).toEqual(sorted(expectedGroupIds));
        expect(sorted(cachedGroupIds)).toEqual(sorted(expectedGroupIds));
      }
    });

    it('returns the same identities from generated member-list SQL', async () => {
      for (const group of groups) {
        const membership = await service.getSqlAndParamsByGroupId(group.id, {});
        expect(membership).not.toBeNull();

        const actualProfileIds = await sqlExecutor
          .execute<{ profile_id: string }>(
            `${membership!.sql}
             select distinct profile_id from ${UserGroupsService.GENERATED_VIEW}`,
            membership!.params
          )
          .then((rows) => rows.map((row) => row.profile_id));
        const expectedProfileIds = expectedMembers
          .get(group)!
          .map((identity) => identity.profile_id!);

        expect(sorted(actualProfileIds)).toEqual(sorted(expectedProfileIds));
      }
    });
  }
);
