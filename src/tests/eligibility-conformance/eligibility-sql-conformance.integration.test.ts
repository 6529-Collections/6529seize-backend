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
      }
      return failures;
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
