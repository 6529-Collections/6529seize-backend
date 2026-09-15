import 'reflect-metadata';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { mock } from 'ts-jest-mocker';
import * as mcache from 'memory-cache';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  XTDH_GRANT_TOKENS_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_STATS_META_TABLE
} from '@/constants';
import { withUserGroups } from '@/tests/fixtures/user-group.fixture';
import { withWaves } from '@/tests/fixtures/wave.fixture';
import { loadMaterializedVectors, MaterializedVector } from './vector-loader';
import { CommunityMembersDb } from '@/api/community-members/community-members.db';
import { CommunityMembersQuery } from '@/api/community-members/community-members.types';
import { ApiCommunityMembersSortOption } from '@/api/generated/models/ApiCommunityMembersSortOption';
import { ApiCreateGroupDescription } from '@/api/generated/models/ApiCreateGroupDescription';
import { PageSortDirection } from '@/api/page-request';
import {
  UserGroupEntity,
  GroupBeneficiaryGrantMatchMode
} from '@/entities/IUserGroup';
import { BadRequestException } from '@/exceptions';

/**
 * Set-based SQL conformance harness (docs/eligibility-spec.md,
 * spec_version 2).
 *
 * Seeds the union of every golden vector's state into one database, then per
 * vector generates each group's member-set SQL with the real
 * `UserGroupsService.getSqlAndParamsByGroupId` and asserts whether the
 * subject profile is in the produced member set.
 *
 * Every generated member set must match the spec-normative outcome
 * (`expected.eligible_group_ids`). Any disagreement is a conformance failure.
 *
 * A final cross-check runs the in-memory engine against the same seeded
 * database, pinning the mocked in-memory suite
 * (`eligibility-in-memory-conformance.test.ts`) to the real DB behavior.
 */

const vectors = loadMaterializedVectors();

function buildCombinedSeeds(allVectors: MaterializedVector[]): Seed[] {
  return [
    {
      table: IDENTITIES_TABLE,
      rows: allVectors.flatMap((vector) => vector.identityRows)
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: allVectors.flatMap((vector) => vector.ackRows)
    },
    withUserGroups(allVectors.flatMap((vector) => vector.groupEntities)),
    withWaves(allVectors.flatMap((vector) => vector.waveRows)),
    {
      table: PROFILE_GROUPS_TABLE,
      rows: allVectors.flatMap((vector) => vector.profileGroupRows)
    },
    {
      table: RATINGS_TABLE,
      rows: allVectors.flatMap((vector) => vector.ratingRows)
    },
    {
      table: NFT_OWNERS_TABLE,
      rows: allVectors.flatMap((vector) => vector.nftOwnerRows)
    },
    {
      table: XTDH_GRANTS_TABLE,
      rows: allVectors.flatMap((vector) => vector.grantRows)
    },
    {
      table: XTDH_GRANT_TOKENS_TABLE,
      rows: allVectors.flatMap((vector) => vector.grantTokenRows)
    },
    {
      table: EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
      rows: allVectors.flatMap((vector) => vector.externalOwnershipRows)
    },
    {
      table: XTDH_STATS_META_TABLE,
      rows: [
        {
          id: 1,
          active_slot: 'a',
          as_of_midnight_ms: 0,
          last_updated_at: new Date(0)
        }
      ]
    }
  ];
}

function groupVectorsByDimension(
  allVectors: MaterializedVector[]
): [string, MaterializedVector[]][] {
  const byDimension = new Map<string, MaterializedVector[]>();
  for (const vector of allVectors) {
    const bucket = byDimension.get(vector.dimension) ?? [];
    bucket.push(vector);
    byDimension.set(vector.dimension, bucket);
  }
  return Array.from(byDimension.entries());
}

describeWithSeed(
  'eligibility conformance: set-based SQL engine vs golden vectors',
  buildCombinedSeeds(vectors),
  () => {
    const userGroupsService = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock(),
      mock()
    );
    const membersDb = new CommunityMembersDb(
      () => sqlExecutor,
      userGroupsService
    );

    beforeEach(() => {
      mcache.clear();
    });

    async function isSubjectInGroupMemberSet(
      groupId: string,
      subjectProfileId: string
    ): Promise<boolean> {
      const viewResult = await userGroupsService.getSqlAndParamsByGroupId(
        groupId,
        {}
      );
      if (viewResult === null) {
        throw new Error(
          `Member-set SQL could not be generated for group ${groupId}`
        );
      }
      const rows = await sqlExecutor.execute<{ profile_id: string }>(
        `${viewResult.sql} select profile_id from ${UserGroupsService.GENERATED_VIEW} where profile_id = :conformance_subject_id`,
        { ...viewResult.params, conformance_subject_id: subjectProfileId }
      );
      return rows.length > 0;
    }

    async function collectVectorFailures(
      vector: MaterializedVector
    ): Promise<string[]> {
      const failures: string[] = [];
      for (const group of vector.groupEntities) {
        const specEligible = vector.expectedEligibleGroupIds.includes(group.id);
        const actual = await isSubjectInGroupMemberSet(
          group.id,
          vector.subjectProfileId
        );
        if (actual !== specEligible) {
          failures.push(
            `[${vector.name}] group ${group.id}: SQL member set says member=${actual}, spec expects ${specEligible}`
          );
        }
        await assertCurrentConsumers(vector, group, specEligible);
      }
      return failures;
    }

    function memberQuery(
      vector: MaterializedVector,
      groupId: string
    ): CommunityMembersQuery {
      return {
        group_id: groupId,
        // A unique wallet selects the subject while exercising the actual
        // member-search pushdown and the identity-shaped member projection.
        param: vector.walletsByIdentitySym[vector.raw.subject][0],
        page: 1,
        page_size: 20,
        sort: ApiCommunityMembersSortOption.Level,
        sort_direction: PageSortDirection.ASC
      };
    }

    async function assertMembersAndCount(
      vector: MaterializedVector,
      groupId: string,
      expected: boolean,
      preview?: ApiCreateGroupDescription
    ): Promise<void> {
      const query = memberQuery(vector, groupId);
      const rows = await membersDb.getCommunityMembers(query, {}, preview);
      const count = await membersDb.countCommunityMembers(query, {}, preview);
      const subject = vector.identityRows.find(
        (row) => row.profile_id === vector.subjectProfileId
      )!;
      expect({
        vector: vector.name,
        groupId,
        preview: !!preview,
        wallets: rows.map((row) => row.wallet),
        count
      }).toEqual({
        vector: vector.name,
        groupId,
        preview: !!preview,
        wallets: expected ? [subject.primary_address] : [],
        count: expected ? 1 : 0
      });
      if (expected) {
        expect(rows[0]).toMatchObject({
          display: subject.handle,
          level: subject.level_raw,
          tdh: subject.tdh,
          xtdh: subject.xtdh,
          rep: subject.rep,
          cic: subject.cic,
          consolidation_key: subject.consolidation_key
        });
      }
    }

    async function assertCurrentConsumers(
      vector: MaterializedVector,
      group: UserGroupEntity,
      expected: boolean
    ): Promise<void> {
      await assertMembersAndCount(vector, group.id, expected);
      const broadcast =
        await userGroupsService.getSqlAndParamsByGroupIdForSystemBroadcast(
          group.id,
          {},
          { forOnlineRecipients: true }
        );
      expect(broadcast).not.toBeNull();
      const recipients = await sqlExecutor.execute<{ profile_id: string }>(
        `${broadcast!.sql} select profile_id from ${UserGroupsService.GENERATED_VIEW} where profile_id = :subject`,
        { ...broadcast!.params, subject: vector.subjectProfileId }
      );
      expect(recipients.map((row) => row.profile_id)).toEqual(
        expected ? [vector.subjectProfileId] : []
      );
      if (!group.visible) {
        // Visibility belongs to saved groups. Unsaved previews have no such flag.
        return;
      }
      const [apiGroup] = await userGroupsService.getApiGroupsByIds(
        [group.id],
        {}
      );
      const addresses = (profileGroupId: string | null) =>
        vector.profileGroupRows
          .filter((row) => row.profile_group_id === profileGroupId)
          .map(
            (row) =>
              vector.identityRows.find(
                (identity) => identity.profile_id === row.profile_id
              )!.primary_address
          );
      const preview: ApiCreateGroupDescription = {
        ...apiGroup.group,
        identity_addresses: addresses(group.profile_group_id),
        excluded_identity_addresses: addresses(group.excluded_profile_group_id)
      };
      const grant = group.is_beneficiary_of_grant_id
        ? vector.grantsById[group.is_beneficiary_of_grant_id]
        : undefined;
      if (
        group.is_beneficiary_of_grant_match_mode ===
          GroupBeneficiaryGrantMatchMode.ALL_TOKENS &&
        grant?.tokenMode === 'ALL'
      ) {
        // This deliberately invalid legacy vector cannot be created or previewed.
        await expect(
          membersDb.getCommunityMembers(
            memberQuery(vector, group.id),
            {},
            preview
          )
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          membersDb.countCommunityMembers(
            memberQuery(vector, group.id),
            {},
            preview
          )
        ).rejects.toBeInstanceOf(BadRequestException);
        return;
      }
      await assertMembersAndCount(vector, group.id, expected, preview);
    }

    for (const [dimension, dimensionVectors] of groupVectorsByDimension(
      vectors
    )) {
      it(`member-set SQL matches the spec for dimension: ${dimension}`, async () => {
        const failures: string[] = [];
        for (const vector of dimensionVectors) {
          failures.push(...(await collectVectorFailures(vector)));
        }
        expect(failures).toEqual([]);
      });
    }

    it('preserves the full empty member projection for invisible public groups and the unfiltered visible list', async () => {
      const invisible = vectors.find(
        (vector) => vector.name === 'invisible-group'
      )!;
      const invisibleQuery = {
        ...memberQuery(invisible, invisible.groupEntities[0].id),
        param: null
      };
      expect(await membersDb.getCommunityMembers(invisibleQuery, {})).toEqual(
        []
      );
      expect(await membersDb.countCommunityMembers(invisibleQuery, {})).toBe(0);
      const zero = vectors.find(
        (vector) => vector.name === 'level-bounds-raw-negative-1'
      )!;
      const visibleQuery = {
        ...memberQuery(zero, zero.groupIdBySym['min-zero']),
        param: null,
        page_size: 1000
      };
      const rows = await membersDb.getCommunityMembers(visibleQuery, {});
      const expectedCount = vectors.reduce(
        (sum, vector) => sum + vector.identityRows.length,
        0
      );
      expect(rows).toHaveLength(expectedCount);
      expect(await membersDb.countCommunityMembers(visibleQuery, {})).toBe(
        expectedCount
      );
      expect(rows.some((row) => row.level === -1)).toBe(true);
    });

    it('uses the same level bounds in wave privilege containment', async () => {
      const vector = vectors.find(
        (item) => item.name === 'level-bounds-raw-negative-1'
      )!;
      const [zero, one, maxZero] = await userGroupsService.getApiGroupsByIds(
        [
          vector.groupIdBySym['min-zero'],
          vector.groupIdBySym['min-one'],
          vector.groupIdBySym['max-zero']
        ],
        {}
      );
      const byId = new Map(
        [zero, one, maxZero].map((group) => [group.id, group])
      );
      const containing = byId.get(vector.groupIdBySym['min-zero'])!;
      const positive = byId.get(vector.groupIdBySym['min-one'])!;
      const lowest = byId.get(vector.groupIdBySym['max-zero'])!;
      expect(
        await userGroupsService.findGroupIdsWithMembersOutsideContainingGroup(
          containing,
          [positive, lowest],
          {}
        )
      ).toEqual([]);
      expect(
        await userGroupsService.findGroupIdsWithMembersOutsideContainingGroup(
          positive,
          [lowest],
          {}
        )
      ).toEqual([lowest.id]);
    });

    it('in-memory engine over the same seeded database matches the spec expectations', async () => {
      const failures: string[] = [];
      for (const vector of vectors) {
        const vectorGroupIds = new Set(
          vector.groupEntities.map((group) => group.id)
        );
        const eligible = await userGroupsService.getGroupsUserIsEligibleFor(
          vector.subjectProfileId
        );
        const actual = eligible
          .filter((id) => vectorGroupIds.has(id))
          .sort((a, b) => a.localeCompare(b));
        const targeted =
          await userGroupsService.getGroupsUserIsEligibleForByIds(
            vector.subjectProfileId,
            Array.from(vectorGroupIds)
          );
        expect(targeted.sort((a, b) => a.localeCompare(b))).toEqual(
          [...vector.expectedEligibleGroupIds].sort((a, b) =>
            a.localeCompare(b)
          )
        );
        const expected = [...vector.expectedEligibleGroupIds].sort((a, b) =>
          a.localeCompare(b)
        );
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push(
            `[${vector.name}] in-memory engine on real DB: got [${actual.join(', ')}], spec expects [${expected.join(', ')}]`
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }
);
