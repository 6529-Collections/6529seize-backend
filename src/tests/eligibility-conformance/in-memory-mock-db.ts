import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { RateMatter, Rating } from '@/entities/IRating';
import { GroupBeneficiaryGrantMatchMode } from '@/entities/IUserGroup';
import { collections } from '@/collections';
import { MaterializedGrant, MaterializedVector } from './vector-loader';

/**
 * Builds a `UserGroupsDb` test double that serves a single conformance
 * vector's profile state. Every method emulates the semantics of the real
 * query it replaces (documented per method) so the in-memory engine can be
 * exercised without a database. The DB-backed suite
 * (`eligibility-sql-conformance.integration.test.ts`) re-runs the same
 * vectors against the real queries, pinning this double to reality.
 */

interface RatingRowDto {
  rater_profile_id: string;
  matter_target_id: string;
  matter: RateMatter;
  matter_category: string;
  rating: number;
}

function toRatingDto(rating: Rating): RatingRowDto {
  return {
    rater_profile_id: rating.rater_profile_id,
    matter_target_id: rating.matter_target_id,
    matter: rating.matter,
    matter_category: rating.matter_category,
    rating: rating.rating
  };
}

/**
 * Emulates `UserGroupsDb.getRatings`: the union of rating rows between the
 * profile and the given users (any matter, both directions) and the
 * profile's REP rows in the given categories (both directions), distinct.
 */
function emulateGetRatings(
  ratings: Rating[],
  profileId: string,
  users: string[],
  categories: string[]
): RatingRowDto[] {
  if (!users.length && !categories.length) {
    return [];
  }
  const matches = ratings.filter((rating) => {
    const byUser =
      users.length > 0 &&
      ((rating.rater_profile_id === profileId &&
        users.includes(rating.matter_target_id)) ||
        (rating.matter_target_id === profileId &&
          users.includes(rating.rater_profile_id)));
    const byCategory =
      categories.length > 0 &&
      rating.matter === RateMatter.REP &&
      categories.includes(rating.matter_category) &&
      (rating.matter_target_id === profileId ||
        rating.rater_profile_id === profileId);
    return byUser || byCategory;
  });
  const seen = new Set<string>();
  const distinct: RatingRowDto[] = [];
  for (const rating of matches) {
    const key = [
      rating.rater_profile_id,
      rating.matter_target_id,
      rating.matter,
      rating.matter_category
    ].join('|');
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(toRatingDto(rating));
    }
  }
  return distinct;
}

/**
 * Emulates `UserGroupsDb.findBeneficiaryGrantGroupIdsForProfile` — the
 * grant-beneficiary semantics of docs/eligibility-spec.md §8:
 * only GRANTED grants count; ALL-mode grants pair with ANY_TOKEN matching on
 * any owned token in the partition; INCLUDE-mode grants match on the granted
 * token set (any vs all distinct tokens); ALL-mode + ALL_TOKENS matches
 * nobody.
 */
function isProfileGrantBeneficiary(
  grant: MaterializedGrant | undefined,
  matchMode: GroupBeneficiaryGrantMatchMode,
  ownedTokensByPartition: Record<string, string[]>
): boolean {
  if (!grant || grant.status !== 'GRANTED') {
    return false;
  }
  const ownedInPartition = ownedTokensByPartition[grant.partition] ?? [];
  if (grant.tokenMode === 'ALL') {
    return (
      matchMode === GroupBeneficiaryGrantMatchMode.ANY_TOKEN &&
      ownedInPartition.length > 0
    );
  }
  const grantedTokens = new Set(grant.tokens);
  const ownedGrantedTokens = collections.distinct(
    ownedInPartition.filter((token) => grantedTokens.has(token))
  );
  if (matchMode === GroupBeneficiaryGrantMatchMode.ANY_TOKEN) {
    return ownedGrantedTokens.length > 0;
  }
  return (
    grantedTokens.size > 0 && ownedGrantedTokens.length === grantedTokens.size
  );
}

export function buildVectorUserGroupsDbMock(
  vector: MaterializedVector
): UserGroupsDb {
  const subjectWallets = new Set(
    vector.walletsByIdentitySym[vector.raw.subject]
  );
  const subjectProfileGroupIds = new Set(
    vector.profileGroupRows
      .filter((row) => row.profile_id === vector.subjectProfileId)
      .map((row) => row.profile_group_id)
  );

  const mockDb = {
    // No profile_group_changes rows are seeded by the vectors.
    getLatestProfileGroupChangeMillis: jest.fn().mockResolvedValue(null),

    // Every vector group is attached to a wave.
    getAllWaveRelatedGroups: jest
      .fn()
      .mockResolvedValue(vector.groupEntities.map((group) => group.id)),

    // Real query selects the identities row and numeric-casts the metrics.
    getIdentityByProfileId: jest.fn(async (profileId: string) => {
      const identity = vector.identityRows.find(
        (row) => row.profile_id === profileId
      );
      return identity ? { ...identity } : null;
    }),

    // Real query filters `visible = true`.
    getByIds: jest.fn(async (ids: string[]) =>
      vector.groupEntities
        .filter((group) => group.visible && ids.includes(group.id))
        .map((group) => ({ ...group }))
    ),

    // Real query joins profile_groups to visible groups on profile_group_id.
    getGroupsUserIsEligibleByIdentity: jest.fn(
      async ({ profileId }: { profileId: string }) => {
        if (profileId !== vector.subjectProfileId) {
          return [];
        }
        return vector.groupEntities
          .filter(
            (group) =>
              group.visible &&
              group.profile_group_id !== null &&
              subjectProfileGroupIds.has(group.profile_group_id)
          )
          .map((group) => group.id);
      }
    ),

    // Real query joins profile_groups on excluded_profile_group_id
    // (no visibility filter).
    getGroupsUserIsExcludedFromByIdentity: jest.fn(
      async ({ profileId }: { profileId: string }) => {
        if (profileId !== vector.subjectProfileId) {
          return [];
        }
        return vector.groupEntities
          .filter(
            (group) =>
              group.excluded_profile_group_id !== null &&
              subjectProfileGroupIds.has(group.excluded_profile_group_id)
          )
          .map((group) => group.id);
      }
    ),

    getRatings: jest.fn(
      async (profileId: string, users: string[], categories: string[]) =>
        emulateGetRatings(vector.ratingRows, profileId, users, categories)
    ),

    // Real query sums the profile's sent ratings, counting only CIC and REP
    // matters (WAVE_REP is ignored).
    getGivenCicAndRep: jest.fn(async (profileId: string) => {
      return vector.ratingRows
        .filter((rating) => rating.rater_profile_id === profileId)
        .reduce(
          (acc, rating) => {
            if (rating.matter === RateMatter.CIC) {
              acc.cic += rating.rating;
            }
            if (rating.matter === RateMatter.REP) {
              acc.rep += rating.rating;
            }
            return acc;
          },
          { cic: 0, rep: 0 }
        );
    }),

    // Real query resolves ownership across the whole consolidation and
    // returns lowercased contract keys with stringified token ids.
    getAllProfileOwnedTokensByProfileIdGroupedByContract: jest.fn(
      async (profileId: string) => {
        if (profileId !== vector.subjectProfileId) {
          return {};
        }
        return vector.nftOwnerRows
          .filter((row) => subjectWallets.has(row.wallet))
          .reduce(
            (acc, row) => {
              const contract = row.contract.toLowerCase();
              acc[contract] = acc[contract] ?? [];
              acc[contract].push(String(row.token_id).toLowerCase());
              return acc;
            },
            {} as Record<string, string[]>
          );
      }
    ),

    findBeneficiaryGrantGroupIdsForProfile: jest.fn(
      async ({
        beneficiaryGrantGroups,
        profileId
      }: {
        beneficiaryGrantGroups: {
          groupId: string;
          grantId: string;
          matchMode: GroupBeneficiaryGrantMatchMode;
        }[];
        profileId: string;
      }) => {
        if (profileId !== vector.subjectProfileId) {
          return [];
        }
        const ownedTokensByPartition = vector.externalOwnershipRows
          .filter((row) => subjectWallets.has(row.owner))
          .reduce(
            (acc, row) => {
              acc[row.partition] = acc[row.partition] ?? [];
              acc[row.partition].push(String(row.token_id));
              return acc;
            },
            {} as Record<string, string[]>
          );
        return beneficiaryGrantGroups
          .filter((group) =>
            isProfileGrantBeneficiary(
              vector.grantsById[group.grantId],
              group.matchMode,
              ownedTokensByPartition
            )
          )
          .map((group) => group.groupId);
      }
    )
  };
  return mockDb as unknown as UserGroupsDb;
}
