import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  GRADIENT_CONTRACT,
  IDENTITIES_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  XTDH_GRANT_TOKENS_TABLE,
  XTDH_GRANTS_TABLE
} from '@/constants';
import {
  getLevelComponentsBorderByLevel,
  getLevelFromScore
} from '@/profiles/profile-level';
import {
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '@/entities/IUserGroup';
import { userGroupsDb, UserGroupsDb } from '@/user-groups/user-groups.db';
import slugify from 'slugify';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import {
  abusivenessCheckService,
  AbusivenessCheckService
} from '@/profiles/abusiveness-check.service';
import { RateMatter } from '@/entities/IRating';
import { ApiChangeGroupVisibility } from '@/api/generated/models/ApiChangeGroupVisibility';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { ApiGroupFilterDirection } from '@/api/generated/models/ApiGroupFilterDirection';
import { ApiGroupDescription } from '@/api/generated/models/ApiGroupDescription';
import { ApiGroupBeneficiaryGrantMatchMode } from '@/api/generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupNftOwnershipMatchMode } from '@/api/generated/models/ApiGroupNftOwnershipMatchMode';
import {
  ApiGroupOwnsNft,
  ApiGroupOwnsNftNameEnum
} from '../generated/models/ApiGroupOwnsNft';
import { Time, Timer } from '@/time';
import * as mcache from 'memory-cache';
import { RequestContext } from '@/request.context';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import { Network } from '@/alchemy-sdk';
import {
  hasGroupGotAnyNonIdentityConditions,
  isAnyGroupByOwningsCriteria,
  isAnyGroupByTotalSentCicOrRepCriteria,
  isGroupViolatingAnySpecificCicCriteria,
  isGroupViolatingAnySpecificRepCriteria,
  isProfileViolatingGroupsProfileCicCriteria,
  isProfileViolatingGroupsProfileLevelCriteria,
  isProfileViolatingGroupsProfileRepCriteria,
  isProfileViolatingGroupsProfileTdhCriteria,
  isProfileViolatingOwnsCriteria,
  isProfileViolatingTotalSentCicCriteria,
  isProfileViolatingTotalSentRepCriteria,
  ProfileSimpleMetrics
} from '@/groups/user-group-predicates';
import { identityFetcher } from '../identities/identity.fetcher';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { identitiesDb } from '@/identities/identities.db';
import { enums } from '@/enums';
import { ids } from '@/ids';
import { collections } from '@/collections';
import {
  clearWaveGroupsCache,
  evictWaveGroupsEntityCache,
  getRedisClient,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_VERSION_CACHE_KEY
} from '@/redis';
import { env } from '@/env';
import { ApiGroupTdhInclusionStrategy } from '../generated/models/ApiGroupTdhInclusionStrategy';
import { assertUnreachable } from '@/assertions';
import { metricsRecorder, MetricsRecorder } from '@/metrics/MetricsRecorder';
import { xTdhRepository } from '@/xtdh/xtdh.repository';
import { XTdhGrantStatus, XTdhGrantTokenMode } from '@/entities/IXTdhGrant';
import { xTdhGrantsFinder } from '@/xtdh/xtdh-grants.finder';
import { xTdhGrantApiConverter } from '../xtdh/grants/xtdh-grant.api-converter';
import { Logger } from '@/logging';
import { membershipMaterializedReader } from '@/membership/membership-materialized.reader';
import {
  membershipRefreshProducer,
  MembershipRefreshReason
} from '@/membership/membership-refresh.producer';

export type NewUserGroupEntity = Omit<
  UserGroupEntity,
  'id' | 'created_at' | 'created_by' | 'is_pure_profile_group'
>;

type GClean = Omit<
  ApiGroupDescription,
  | 'identity_group_identities_count'
  | 'excluded_identity_group_identities_count'
  | 'is_beneficiary_of_grant'
>;

type EligibleGroupsCacheEntry = {
  readonly eligibleGroupIds: string[];
  readonly computedAtMillis: number;
  readonly waveGroupsVersion: number;
};

type ProfileGroupRating = {
  readonly other_side_id: string;
  readonly matter: RateMatter;
  readonly matter_category: string;
  readonly rating: number;
};

type GroupedProfileRatings = {
  readonly incomingRatings: ProfileGroupRating[];
  readonly outgoingRatings: ProfileGroupRating[];
};

type DirectGroupInvolvement = {
  readonly groupsIdsUserIsEligibleByIdentity: string[];
  readonly groupIdsUserIsBannedFromByIdentity: string[];
};

type PrefetchedEligibilityCheckData = {
  readonly profile: ProfileSimpleMetrics;
  readonly directInvolvement: DirectGroupInvolvement;
  readonly sentCicAndRep: { cic: number; rep: number } | undefined;
  readonly ownings: Record<string, string[]> | undefined;
  readonly groupedRatings: GroupedProfileRatings | undefined;
  readonly groupIdsWhereProfileIsBeneficiary: string[] | undefined;
};

const DEFAULT_ELIGIBLE_GROUPS_CACHE_TTL_SEC = 60;
const ELIGIBLE_GROUPS_MEMORY_CACHE_PREFIX = 'eligible-groups-v2';
const ELIGIBLE_GROUPS_REDIS_CACHE_PREFIX = 'cache_6529_eligible_groups';
const ELIGIBLE_GROUPS_REDIS_LOCK_PREFIX = 'cache_6529_eligible_groups_lock';
const ELIGIBLE_GROUPS_REDIS_LOCK_TTL_MS = 10_000;
const ELIGIBLE_GROUPS_REDIS_LOCK_WAIT_RETRIES = 4;
const ELIGIBLE_GROUPS_REDIS_LOCK_WAIT_MS = 75;
const eligibleGroupsPromisesByProfileId = new Map<string, Promise<string[]>>();
const logger = Logger.get('USER_GROUPS_SERVICE');
const DEFAULT_BENEFICIARY_GRANT_MATCH_MODE =
  GroupBeneficiaryGrantMatchMode.ANY_TOKEN;
const DEFAULT_NFT_OWNERSHIP_MATCH_MODE = GroupNftOwnershipMatchMode.ALL_TOKENS;

export class UserGroupsService {
  public static readonly GENERATED_VIEW = 'user_groups_view';

  constructor(
    private readonly userGroupsDb: UserGroupsDb,
    private readonly abusivenessCheckService: AbusivenessCheckService,
    private readonly metricsRecorder: MetricsRecorder
  ) {}

  private async timeAsync<T>(
    timer: Timer | undefined,
    key: string,
    action: () => Promise<T>
  ): Promise<T> {
    timer?.start(key);
    try {
      return await action();
    } finally {
      timer?.stop(key);
    }
  }

  private timeSync<T>(
    timer: Timer | undefined,
    key: string,
    action: () => T
  ): T {
    timer?.start(key);
    try {
      return action();
    } finally {
      timer?.stop(key);
    }
  }

  async save(
    group: Omit<
      NewUserGroupEntity,
      'profile_group_id' | 'excluded_profile_group_id'
    > & {
      addresses: string[];
      excluded_addresses: string[];
    },
    createdBy: string,
    ctx: RequestContext,
    isVisible = false
  ): Promise<ApiGroupFull> {
    const savedEntity =
      await this.userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const id =
            slugify(group.name, {
              replacement: '-',
              lower: true,
              strict: true
            }).slice(0, 50) +
            '-' +
            ids.uniqueShortId();
          const beneficiaryOfGrantId = group.is_beneficiary_of_grant_id;
          const beneficiaryGrantMatchMode =
            group.is_beneficiary_of_grant_match_mode ??
            DEFAULT_BENEFICIARY_GRANT_MATCH_MODE;
          if (
            !beneficiaryOfGrantId &&
            beneficiaryGrantMatchMode ===
              GroupBeneficiaryGrantMatchMode.ALL_TOKENS
          ) {
            throw new BadRequestException(
              `Beneficiary grant match mode ALL_TOKENS requires an xTDH grant`
            );
          }
          if (beneficiaryOfGrantId) {
            const grantEntity = await xTdhRepository.getGrantById(
              beneficiaryOfGrantId,
              ctxWithConnection
            );
            if (!grantEntity) {
              throw new NotFoundException(
                `Can't create group based on grant ${beneficiaryOfGrantId} as it doesn't exist`
              );
            }
            if (
              beneficiaryGrantMatchMode ===
                GroupBeneficiaryGrantMatchMode.ALL_TOKENS &&
              grantEntity.token_mode !== XTdhGrantTokenMode.INCLUDE
            ) {
              throw new BadRequestException(
                `Beneficiary grant match mode ALL_TOKENS can only be used with grants that specify target tokens`
              );
            }
          }
          const inclusionGroups = group.addresses.length
            ? await this.userGroupsDb.insertGroupEntriesAndGetGroupIds(
                group.addresses,
                connection
              )
            : null;
          const exclusionGroups = group.excluded_addresses.length
            ? await this.userGroupsDb.insertGroupEntriesAndGetGroupIds(
                group.excluded_addresses,
                connection
              )
            : null;
          await this.userGroupsDb.save(
            {
              ...group,
              id,
              created_at: new Date(),
              created_by: createdBy,
              visible: isVisible,
              name: group.name,
              profile_group_id: inclusionGroups?.profile_group_id ?? null,
              excluded_profile_group_id:
                exclusionGroups?.profile_group_id ?? null
            },
            connection
          );
          if (isVisible) {
            await membershipRefreshProducer.markGroupsDirty(
              [id],
              MembershipRefreshReason.GROUP_CHANGED,
              ctxWithConnection
            );
          }
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: createdBy },
            ctxWithConnection
          );
          return await this.getByIdOrThrow(id, ctxWithConnection);
        }
      );
    await membershipRefreshProducer.enqueueDirtyRefreshBestEffort();
    await giveReadReplicaTimeToCatchUp();
    if (this.isNewGroupEligibilityScopedToItsMembers(group)) {
      // Inclusion-list-only group: every listed (and excluded) member already
      // got an individual profile_group_changes bump when the list rows were
      // inserted, and nobody outside the list can be affected. Skip the global
      // version bump which would invalidate all profiles' eligibility caches.
      await evictWaveGroupsEntityCache();
    } else {
      await clearWaveGroupsCache();
    }
    await this.invalidateGroupsUserIsEligibleFor(createdBy);
    return savedEntity;
  }

  /**
   * True if the new group's eligibility is fully determined by an explicit
   * inclusion list (has addresses, no criteria conditions). An exclusions-only
   * group means "everyone except X" and a criteria group can match anyone, so
   * both of those can affect profiles outside any member list.
   */
  private isNewGroupEligibilityScopedToItsMembers(
    group: Omit<
      NewUserGroupEntity,
      'profile_group_id' | 'excluded_profile_group_id'
    > & {
      addresses: string[];
    }
  ): boolean {
    return (
      group.addresses.length > 0 &&
      !hasGroupGotAnyNonIdentityConditions({
        ...group,
        id: '',
        created_at: new Date(),
        created_by: '',
        profile_group_id: null,
        excluded_profile_group_id: null,
        is_pure_profile_group: false
      })
    );
  }

  public async findOrCreateDirectMessageGroup(
    creatorProfile: ApiIdentity,
    identityAddresses: string[],
    ctx: RequestContext
  ): Promise<ApiGroupFull> {
    const uniqueIdentityAddresses = collections.distinct(identityAddresses);
    const allAddresses = collections.distinct([
      creatorProfile.primary_wallet,
      ...uniqueIdentityAddresses
    ]);
    const existingGroup = await this.userGroupsDb.findDirectMessageGroup(
      allAddresses,
      ctx
    );
    if (existingGroup) {
      return (await this.mapForApi([existingGroup], ctx))[0];
    }
    const handles = await identitiesDb.getHandlesByPrimaryWallets(
      uniqueIdentityAddresses,
      ctx.connection
    );
    if (handles.length !== uniqueIdentityAddresses.length) {
      throw new BadRequestException(`Invalid identity addresses.`);
    }
    const name = `DM - ${[creatorProfile.handle, ...handles].join(' / ')}`;
    const userGroup: Omit<
      NewUserGroupEntity,
      'profile_group_id' | 'excluded_profile_group_id'
    > & {
      addresses: string[];
      excluded_addresses: string[];
    } = {
      name,
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
      owns_gradient: false,
      owns_lab: false,
      owns_nextgen: false,
      owns_meme_tokens: null,
      owns_meme_tokens_match_mode: DEFAULT_NFT_OWNERSHIP_MATCH_MODE,
      owns_gradient_tokens: null,
      owns_gradient_tokens_match_mode: DEFAULT_NFT_OWNERSHIP_MATCH_MODE,
      owns_lab_tokens: null,
      owns_lab_tokens_match_mode: DEFAULT_NFT_OWNERSHIP_MATCH_MODE,
      owns_nextgen_tokens: null,
      owns_nextgen_tokens_match_mode: DEFAULT_NFT_OWNERSHIP_MATCH_MODE,
      addresses: allAddresses,
      excluded_addresses: [],
      visible: true,
      is_private: true,
      is_direct_message: true,
      is_beneficiary_of_grant_id: null,
      is_beneficiary_of_grant_match_mode: DEFAULT_BENEFICIARY_GRANT_MATCH_MODE
    };

    return await this.save(userGroup, creatorProfile.id!, ctx, true);
  }

  private async whichOfGivenGroupsIsUserEligibleFor(
    {
      profileId,
      givenGroups,
      preloadedGroupEntities
    }: {
      profileId: string;
      givenGroups?: string[];
      preloadedGroupEntities?: UserGroupEntity[];
    },
    timer?: Timer
  ): Promise<string[]> {
    return this.timeAsync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor',
      async () => {
        const givenGroupEntities =
          preloadedGroupEntities ??
          (givenGroups?.length
            ? await this.getGivenGroupEntities(givenGroups, timer)
            : []);
        if (!givenGroupEntities.length) {
          return [];
        }
        const prefetchedData = await this.prefetchEligibilityCheckData(
          profileId,
          givenGroupEntities,
          timer
        );
        if (!prefetchedData) {
          return [];
        }
        return this.applyEliminationChain(
          givenGroupEntities,
          prefetchedData,
          timer
        );
      }
    );
  }

  private async prefetchEligibilityCheckData(
    profileId: string,
    candidateGroupEntities: UserGroupEntity[],
    timer?: Timer
  ): Promise<PrefetchedEligibilityCheckData | null> {
    // The needed datasets are derived from the FULL candidate set, which is a
    // superset of what the previous sequential flow fetched (it derived each
    // stage's needs from the already-filtered group list). Results are
    // identical because each eliminate filter only reads the rows matching its
    // own group's criteria.
    const needsSentCicAndRep = isAnyGroupByTotalSentCicOrRepCriteria(
      candidateGroupEntities
    );
    const needsOwnings = isAnyGroupByOwningsCriteria(candidateGroupEntities);
    const { users, categories } =
      this.extractAllCicRepUsersAndCategoriesFromGroups(candidateGroupEntities);
    const needsGranularRatings = users.length !== 0 || categories.length !== 0;
    const beneficiaryGrantGroups = candidateGroupEntities
      .filter((group) => !!group.is_beneficiary_of_grant_id)
      .map((group) => ({
        groupId: group.id,
        grantId: group.is_beneficiary_of_grant_id!,
        matchMode:
          group.is_beneficiary_of_grant_match_mode ??
          DEFAULT_BENEFICIARY_GRANT_MATCH_MODE
      }));
    const [
      identityEntity,
      directInvolvement,
      sentCicAndRep,
      ownings,
      groupedRatings,
      groupIdsWhereProfileIsBeneficiary
    ] = await Promise.all([
      this.timeAsync(
        timer,
        'whichOfGivenGroupsIsUserEligibleFor->getIdentityByProfileId',
        () => this.userGroupsDb.getIdentityByProfileId(profileId)
      ),
      this.getGroupsUserIsDirectlyInvolvedIn(
        {
          profileId,
          candidates: candidateGroupEntities.map((it) => it.id)
        },
        timer
      ),
      needsSentCicAndRep
        ? this.timeAsync(
            timer,
            'whichOfGivenGroupsIsUserEligibleFor->getGivenCicAndRep',
            () => this.userGroupsDb.getGivenCicAndRep(profileId)
          )
        : undefined,
      needsOwnings
        ? this.userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract(
            profileId,
            { timer }
          )
        : undefined,
      needsGranularRatings
        ? this.timeAsync(
            timer,
            'whichOfGivenGroupsIsUserEligibleFor->getIncomingOutgoingGroupedRatings',
            () =>
              this.getIncomingOutgoingGroupedRatings(
                profileId,
                users,
                categories
              )
          )
        : undefined,
      beneficiaryGrantGroups.length
        ? this.userGroupsDb.findBeneficiaryGrantGroupIdsForProfile(
            { beneficiaryGrantGroups, profileId },
            { timer }
          )
        : undefined
    ]);
    if (!identityEntity) {
      return null;
    }
    return {
      profile: {
        profile_id: identityEntity.profile_id!,
        rep: identityEntity.rep,
        cic: identityEntity.cic,
        tdh: identityEntity.tdh,
        xtdh: identityEntity.xtdh,
        level: getLevelFromScore(identityEntity.level_raw)
      },
      directInvolvement,
      sentCicAndRep,
      ownings,
      groupedRatings,
      groupIdsWhereProfileIsBeneficiary
    };
  }

  private applyEliminationChain(
    givenGroupEntities: UserGroupEntity[],
    prefetchedData: PrefetchedEligibilityCheckData,
    timer?: Timer
  ): string[] {
    const { groupsWhereUserIsInByIdentity, groupsInNeedOfAdditionalCheck } =
      this.eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck(
        givenGroupEntities,
        prefetchedData.directInvolvement,
        timer
      );
    const groupsAfterSimpleMetricsCheck =
      this.eliminateGroupsBySimpleMetricsViolations(
        groupsInNeedOfAdditionalCheck,
        prefetchedData.profile,
        timer
      );
    const groupsAfterTotalSentCheck =
      this.eliminateGroupsByFullOutgoingCicAndRep(
        groupsAfterSimpleMetricsCheck,
        prefetchedData.sentCicAndRep,
        timer
      );
    const groupsAfterOwningsCheck = this.eliminateGroupsByOwnings(
      groupsAfterTotalSentCheck,
      prefetchedData.ownings,
      timer
    );
    const groupsAfterGranularRatingsCheck =
      this.eliminateGroupsByGranularRatings(
        groupsAfterOwningsCheck,
        prefetchedData.groupedRatings,
        timer
      );
    const groupEntitiesWhichPassedAllChecks =
      this.eliminateGroupsByBeneficiaryGrants(
        groupsAfterGranularRatingsCheck,
        prefetchedData.groupIdsWhereProfileIsBeneficiary,
        timer
      );
    return [
      ...groupEntitiesWhichPassedAllChecks.map((it) => it.id),
      ...groupsWhereUserIsInByIdentity.map((it) => it.id)
    ];
  }

  private async getGivenGroupEntities(
    givenGroups: string[],
    timer?: Timer
  ): Promise<UserGroupEntity[]> {
    return this.timeAsync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->getGivenGroupEntities',
      () =>
        this.userGroupsDb.getByIds(givenGroups, {
          timer
        })
    );
  }

  private async getAllWaveRelatedGroupEntities(
    timer?: Timer
  ): Promise<UserGroupEntity[]> {
    const timerPrefix =
      'whichOfGivenGroupsIsUserEligibleFor->getGivenGroupEntities';
    const redisClient = getRedisClient();
    if (!redisClient) {
      const givenGroups = await this.getAllWaveRelatedGroupIds(timer);
      return await this.timeAsync(
        timer,
        `${timerPrefix}->redisUnavailableGetByIds`,
        () =>
          this.userGroupsDb.getByIds(givenGroups, {
            timer
          })
      );
    }

    const cachedValue = await this.timeAsync(
      timer,
      `${timerPrefix}->redisGet`,
      () => redisClient.get(WAVE_GROUPS_CACHE_KEY)
    );
    if (cachedValue) {
      return this.timeSync(timer, `${timerPrefix}->redisJsonParse`, () =>
        JSON.parse(cachedValue)
      ) as UserGroupEntity[];
    }

    // The waves + wave_curations scan only runs when the Redis entity blob
    // misses. The cache key and the stored shape (array of UserGroupEntity)
    // must stay unchanged for compatibility with other invalidation call
    // sites and rolling deploys.
    const givenGroups = await this.getAllWaveRelatedGroupIds(timer);
    const value = await this.timeAsync(
      timer,
      `${timerPrefix}->redisMissGetByIds`,
      () =>
        this.userGroupsDb.getByIds(givenGroups, {
          timer
        })
    );
    const payload = this.timeSync(
      timer,
      `${timerPrefix}->redisJsonStringify`,
      () => JSON.stringify(value)
    );
    const ttlSec = env.getIntOrNull('WAVE_GROUPS_CACHE_TTL_SEC') ?? 60;
    await this.timeAsync(timer, `${timerPrefix}->redisSet`, () =>
      redisClient.set(WAVE_GROUPS_CACHE_KEY, payload, {
        EX: Time.seconds(ttlSec).toSeconds()
      })
    );
    return value;
  }

  private async getAllWaveRelatedGroupIds(timer?: Timer): Promise<string[]> {
    return await this.timeAsync(
      timer,
      'getGroupsUserIsEligibleFor->getAllWaveRelatedGroups',
      () => this.userGroupsDb.getAllWaveRelatedGroups({ timer })
    );
  }

  private eliminateGroupsByBeneficiaryGrants(
    groups: UserGroupEntity[],
    groupIdsWhereProfileIsBeneficiary: string[] | undefined,
    timer?: Timer
  ): UserGroupEntity[] {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateGroupsByBeneficiaryGrants',
      () => {
        if (groupIdsWhereProfileIsBeneficiary === undefined) {
          return groups;
        }
        return groups.filter(
          (group) =>
            !group.is_beneficiary_of_grant_id ||
            groupIdsWhereProfileIsBeneficiary.includes(group.id)
        );
      }
    );
  }

  private eliminateGroupsByGranularRatings(
    groups: UserGroupEntity[],
    groupedRatings: GroupedProfileRatings | undefined,
    timer?: Timer
  ): UserGroupEntity[] {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateGroupsByGranularRatings',
      () => {
        if (!groupedRatings) {
          return groups;
        }
        const { outgoingRatings, incomingRatings } = groupedRatings;
        return groups.filter(
          (entity) =>
            !isGroupViolatingAnySpecificRepCriteria(
              entity,
              incomingRatings,
              outgoingRatings
            ) &&
            !isGroupViolatingAnySpecificCicCriteria(
              entity,
              incomingRatings,
              outgoingRatings
            )
        );
      }
    );
  }

  private async getIncomingOutgoingGroupedRatings(
    profileId: string,
    users: string[],
    categories: string[]
  ): Promise<GroupedProfileRatings> {
    const ratings = await this.userGroupsDb.getRatings(
      profileId,
      users,
      categories
    );
    const { outgoingRatings, incomingRatings } = ratings.reduce(
      (acc, rating) => {
        if (rating.rater_profile_id === profileId) {
          acc.outgoingRatings.push({
            matter: rating.matter,
            matter_category: rating.matter_category,
            rating: rating.rating,
            other_side_id: rating.matter_target_id
          });
        } else {
          acc.incomingRatings.push({
            matter: rating.matter,
            matter_category: rating.matter_category,
            rating: rating.rating,
            other_side_id: rating.rater_profile_id
          });
        }
        return acc;
      },
      { outgoingRatings: [], incomingRatings: [] } as {
        incomingRatings: ProfileGroupRating[];
        outgoingRatings: ProfileGroupRating[];
      }
    );
    return {
      outgoingRatings,
      incomingRatings
    };
  }

  private extractAllCicRepUsersAndCategoriesFromGroups(
    groups: UserGroupEntity[]
  ): { users: string[]; categories: string[] } {
    const { usersSet, categoriesSet } = groups.reduce(
      (acc, entity) => {
        if (entity.cic_user) {
          acc.usersSet.add(entity.cic_user);
        }
        if (entity.rep_user) {
          acc.usersSet.add(entity.rep_user);
        }
        if (entity.rep_category) {
          acc.categoriesSet.add(entity.rep_category);
        }
        return acc;
      },
      { usersSet: new Set(), categoriesSet: new Set() } as {
        usersSet: Set<string>;
        categoriesSet: Set<string>;
      }
    );
    const users = Array.from(usersSet);
    const categories = Array.from(categoriesSet);
    return { users, categories };
  }

  private eliminateGroupsByOwnings(
    groups: UserGroupEntity[],
    ownings: Record<string, string[]> | undefined,
    timer?: Timer
  ): UserGroupEntity[] {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateGroupsByOwnings',
      () => {
        if (!ownings) {
          return groups;
        }
        return groups.filter(
          (entity) => !isProfileViolatingOwnsCriteria(entity, ownings)
        );
      }
    );
  }

  private eliminateGroupsByFullOutgoingCicAndRep(
    groups: UserGroupEntity[],
    sentCicAndRep: { cic: number; rep: number } | undefined,
    timer?: Timer
  ): UserGroupEntity[] {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateGroupsByFullOutgoingCicAndRep',
      () => {
        if (!sentCicAndRep) {
          return groups;
        }
        const { cic, rep } = sentCicAndRep;
        return groups.filter(
          (entity) =>
            !isProfileViolatingTotalSentCicCriteria(cic, entity) &&
            !isProfileViolatingTotalSentRepCriteria(rep, entity)
        );
      }
    );
  }

  private eliminateGroupsBySimpleMetricsViolations(
    groups: UserGroupEntity[],
    profile: ProfileSimpleMetrics,
    timer?: Timer
  ): UserGroupEntity[] {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateGroupsBySimpleMetricsViolations',
      () =>
        groups.filter(
          (entity) =>
            !isProfileViolatingGroupsProfileTdhCriteria(profile, entity) &&
            !isProfileViolatingGroupsProfileLevelCriteria(profile, entity) &&
            !isProfileViolatingGroupsProfileCicCriteria(profile, entity) &&
            !isProfileViolatingGroupsProfileRepCriteria(profile, entity)
        )
    );
  }

  private eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck(
    groups: UserGroupEntity[],
    directInvolvement: DirectGroupInvolvement,
    timer?: Timer
  ): {
    groupsWhereUserIsInByIdentity: UserGroupEntity[];
    groupsInNeedOfAdditionalCheck: UserGroupEntity[];
  } {
    return this.timeSync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->eliminateBannedGroupsAndDirectIdentityGroups',
      () => {
        const {
          groupsIdsUserIsEligibleByIdentity,
          groupIdsUserIsBannedFromByIdentity
        } = directInvolvement;

        const nonBannedGroups = groups.filter(
          (it) => !groupIdsUserIsBannedFromByIdentity.includes(it.id)
        );
        const groupsWhereUserIsInByIdentity = nonBannedGroups.filter((it) =>
          groupsIdsUserIsEligibleByIdentity.includes(it.id)
        );
        const groupsInNeedOfAdditionalCheck = nonBannedGroups
          .filter((it) => hasGroupGotAnyNonIdentityConditions(it))
          .filter((it) => !groupsIdsUserIsEligibleByIdentity.includes(it.id));
        const groupsWhereUserIsInJustByMissingExclusion =
          nonBannedGroups.filter(
            (it) =>
              !it.profile_group_id &&
              !!it.excluded_profile_group_id &&
              !groupIdsUserIsBannedFromByIdentity.includes(it.id) &&
              !hasGroupGotAnyNonIdentityConditions(it)
          );
        return {
          groupsWhereUserIsInByIdentity,
          groupsInNeedOfAdditionalCheck: [
            ...groupsInNeedOfAdditionalCheck,
            ...groupsWhereUserIsInJustByMissingExclusion
          ]
        };
      }
    );
  }

  private async getGroupsUserIsDirectlyInvolvedIn(
    {
      profileId,
      candidates
    }: {
      profileId: string;
      candidates: string[];
    },
    timer?: Timer
  ): Promise<DirectGroupInvolvement> {
    return this.timeAsync(
      timer,
      'whichOfGivenGroupsIsUserEligibleFor->getGroupsUserIsDirectlyInvolvedIn',
      async () => {
        const [
          groupsIdsUserIsEligibleByIdentity,
          groupIdsUserIsBannedFromByIdentity
        ] = await Promise.all([
          this.timeAsync(
            timer,
            'whichOfGivenGroupsIsUserEligibleFor->getGroupsUserIsDirectlyInvolvedIn->eligibleByIdentity',
            () =>
              this.userGroupsDb.getGroupsUserIsEligibleByIdentity({
                profileId
              })
          ),
          this.timeAsync(
            timer,
            'whichOfGivenGroupsIsUserEligibleFor->getGroupsUserIsDirectlyInvolvedIn->excludedByIdentity',
            () =>
              this.userGroupsDb.getGroupsUserIsExcludedFromByIdentity({
                profileId
              })
          )
        ]);

        return {
          groupsIdsUserIsEligibleByIdentity:
            groupsIdsUserIsEligibleByIdentity.filter((it) =>
              candidates.includes(it)
            ),
          groupIdsUserIsBannedFromByIdentity:
            groupIdsUserIsBannedFromByIdentity.filter((it) =>
              candidates.includes(it)
            )
        };
      }
    );
  }

  public async invalidateGroupsUserIsEligibleFor(profileId: string) {
    mcache.del(this.getEligibleGroupsMemoryCacheKey(profileId));
    eligibleGroupsPromisesByProfileId.delete(profileId);
    const redisClient = getRedisClient();
    if (!redisClient) {
      return;
    }
    await redisClient
      .del(this.getEligibleGroupsRedisCacheKey(profileId))
      .catch(() => undefined);
  }

  public async getGroupsUserIsEligibleFor(
    profileId: string | null,
    timer?: Timer | undefined
  ): Promise<string[]> {
    if (!profileId) {
      return [];
    }
    const timerKey = 'getGroupsUserIsEligibleFor';
    return this.timeAsync(timer, timerKey, async () => {
      const existingPromise = eligibleGroupsPromisesByProfileId.get(profileId);
      if (existingPromise !== undefined) {
        return await this.timeAsync(
          timer,
          `${timerKey}->localInFlightWait`,
          () => existingPromise
        );
      }

      const promise = this.getGroupsUserIsEligibleForByReadMode(
        profileId,
        timer
      );
      eligibleGroupsPromisesByProfileId.set(profileId, promise);
      try {
        return await promise;
      } finally {
        if (eligibleGroupsPromisesByProfileId.get(profileId) === promise) {
          eligibleGroupsPromisesByProfileId.delete(profileId);
        }
      }
    });
  }

  private async getGroupsUserIsEligibleForByReadMode(
    profileId: string,
    timer?: Timer
  ): Promise<string[]> {
    const readMode = membershipMaterializedReader.getReadMode();
    const materialized =
      await membershipMaterializedReader.getEligibleGroupIdsIfReady(profileId, {
        timer
      });
    if (readMode === 'materialized' && materialized !== null) {
      this.logEligibilityRead({
        profileId,
        level: 'materialized',
        resultCount: materialized.length
      });
      return materialized;
    }
    const legacy = await this.getGroupsUserIsEligibleForWithCache(
      profileId,
      timer
    );
    if (readMode === 'shadow' && materialized !== null) {
      this.logMaterializedShadowComparison(profileId, legacy, materialized);
    }
    return legacy;
  }

  private async getGroupsUserIsEligibleForWithCache(
    profileId: string,
    timer?: Timer | undefined
  ): Promise<string[]> {
    const timerKey = 'getGroupsUserIsEligibleFor';
    const ttlSec = this.getEligibleGroupsCacheTtlSec();
    const [latestProfileGroupChangeMillis, waveGroupsVersion] =
      await Promise.all([
        this.timeAsync(
          timer,
          `${timerKey}->getLatestProfileGroupChangeMillis`,
          () => this.userGroupsDb.getLatestProfileGroupChangeMillis(profileId)
        ),
        this.getWaveGroupsCacheVersion(timer)
      ]);

    const memoryCacheEntry = this.timeSync(
      timer,
      `${timerKey}->memoryCacheLookup`,
      () =>
        mcache.get(
          this.getEligibleGroupsMemoryCacheKey(profileId)
        ) as EligibleGroupsCacheEntry | null
    );
    if (
      this.isEligibleGroupsCacheEntryValid(
        memoryCacheEntry,
        latestProfileGroupChangeMillis,
        waveGroupsVersion
      )
    ) {
      return memoryCacheEntry.eligibleGroupIds;
    }

    const redisCacheEntry = await this.getEligibleGroupsRedisCacheEntry(
      profileId,
      timer
    );
    if (
      this.isEligibleGroupsCacheEntryValid(
        redisCacheEntry,
        latestProfileGroupChangeMillis,
        waveGroupsVersion
      )
    ) {
      this.putEligibleGroupsMemoryCache(profileId, redisCacheEntry, ttlSec);
      this.logEligibilityRead({
        profileId,
        level: 'redis',
        resultCount: redisCacheEntry.eligibleGroupIds.length
      });
      return redisCacheEntry.eligibleGroupIds;
    }

    const acquiredRedisLock = await this.tryAcquireEligibleGroupsRedisLock(
      profileId,
      timer
    );
    if (!acquiredRedisLock) {
      const waitedCacheEntry = await this.waitForEligibleGroupsRedisCacheEntry({
        profileId,
        latestProfileGroupChangeMillis,
        waveGroupsVersion,
        ttlSec,
        timer
      });
      if (waitedCacheEntry) {
        this.logEligibilityRead({
          profileId,
          level: 'lock_wait',
          resultCount: waitedCacheEntry.eligibleGroupIds.length
        });
        return waitedCacheEntry.eligibleGroupIds;
      }
    }

    const computeStartMillis = Time.currentMillis();
    const results = await this.computeGroupsUserIsEligibleForUncached(
      profileId,
      timer
    );
    const computedAtMillis = Time.currentMillis();
    const latestProfileGroupChangeMillisAfterCompute = await this.timeAsync(
      timer,
      `${timerKey}->getLatestProfileGroupChangeMillisAfterCompute`,
      () => this.userGroupsDb.getLatestProfileGroupChangeMillis(profileId)
    );
    if (
      this.hasProfileGroupChangeAdvanced(
        latestProfileGroupChangeMillis,
        latestProfileGroupChangeMillisAfterCompute
      )
    ) {
      this.logEligibilityRead({
        profileId,
        level: 'computed',
        computeMs: computedAtMillis - computeStartMillis,
        resultCount: results.length,
        cached: false
      });
      return results;
    }

    const cacheEntry: EligibleGroupsCacheEntry = {
      eligibleGroupIds: results,
      computedAtMillis,
      waveGroupsVersion
    };
    this.putEligibleGroupsMemoryCache(profileId, cacheEntry, ttlSec);
    await this.putEligibleGroupsRedisCache(
      profileId,
      cacheEntry,
      ttlSec,
      timer
    );
    this.logEligibilityRead({
      profileId,
      level: 'computed',
      computeMs: computedAtMillis - computeStartMillis,
      resultCount: results.length,
      cached: true
    });
    return results;
  }

  private logEligibilityRead(param: {
    readonly profileId: string;
    readonly level: 'materialized' | 'redis' | 'lock_wait' | 'computed';
    readonly computeMs?: number;
    readonly resultCount: number;
    readonly cached?: boolean;
  }) {
    // Memory-cache hits are deliberately not logged: they are the dominant
    // path and would flood the logs without adding attribution value.
    logger.info(`[ELIGIBILITY_READ] ${JSON.stringify(param)}`);
  }

  private logMaterializedShadowComparison(
    profileId: string,
    legacy: string[],
    materialized: string[]
  ): void {
    const legacySet = new Set(legacy);
    const materializedSet = new Set(materialized);
    const missing = legacy.filter((groupId) => !materializedSet.has(groupId));
    const extra = materialized.filter((groupId) => !legacySet.has(groupId));
    logger.info(
      `[ELIGIBILITY_MATERIALIZED_SHADOW] ${JSON.stringify({
        profileId,
        matches: missing.length === 0 && extra.length === 0,
        missing,
        extra
      })}`
    );
  }

  private hasProfileGroupChangeAdvanced(
    beforeMillis: number | null,
    afterMillis: number | null
  ): boolean {
    if (afterMillis === null) {
      return false;
    }
    if (beforeMillis === null) {
      return true;
    }
    return afterMillis > beforeMillis;
  }

  public async computeGroupsUserIsEligibleForUncached(
    profileId: string,
    timer?: Timer | undefined
  ): Promise<string[]> {
    const groupEntities = await this.getAllWaveRelatedGroupEntities(timer);
    return await this.whichOfGivenGroupsIsUserEligibleFor(
      { profileId, preloadedGroupEntities: groupEntities },
      timer
    );
  }

  private getEligibleGroupsCacheTtlSec(): number {
    return Math.max(
      1,
      env.getIntOrNull('USER_GROUPS_ELIGIBILITY_CACHE_TTL_SEC') ??
        DEFAULT_ELIGIBLE_GROUPS_CACHE_TTL_SEC
    );
  }

  private getEligibleGroupsMemoryCacheKey(profileId: string): string {
    return `${ELIGIBLE_GROUPS_MEMORY_CACHE_PREFIX}-${profileId}`;
  }

  private getEligibleGroupsRedisCacheKey(profileId: string): string {
    return `${ELIGIBLE_GROUPS_REDIS_CACHE_PREFIX}:${profileId}`;
  }

  private getEligibleGroupsRedisLockKey(profileId: string): string {
    return `${ELIGIBLE_GROUPS_REDIS_LOCK_PREFIX}:${profileId}`;
  }

  private putEligibleGroupsMemoryCache(
    profileId: string,
    cacheEntry: EligibleGroupsCacheEntry,
    ttlSec: number
  ) {
    this.timeSync(undefined, 'getGroupsUserIsEligibleFor->memoryCachePut', () =>
      mcache.put(
        this.getEligibleGroupsMemoryCacheKey(profileId),
        cacheEntry,
        Time.seconds(ttlSec).toMillis()
      )
    );
  }

  private async getWaveGroupsCacheVersion(
    timer?: Timer | undefined
  ): Promise<number> {
    const redisClient = getRedisClient();
    if (!redisClient) {
      return 0;
    }
    return await this.timeAsync(
      timer,
      'getGroupsUserIsEligibleFor->waveGroupsVersionRedisGet',
      async () => {
        const cachedVersion = await redisClient
          .get(WAVE_GROUPS_VERSION_CACHE_KEY)
          .catch(() => null);
        const parsed = Number(cachedVersion);
        return Number.isFinite(parsed) ? parsed : 0;
      }
    );
  }

  private async getEligibleGroupsRedisCacheEntry(
    profileId: string,
    timer?: Timer | undefined
  ): Promise<EligibleGroupsCacheEntry | null> {
    const redisClient = getRedisClient();
    if (!redisClient) {
      return null;
    }
    return await this.timeAsync(
      timer,
      'getGroupsUserIsEligibleFor->redisCacheGet',
      async () => {
        const cachedValue = await redisClient
          .get(this.getEligibleGroupsRedisCacheKey(profileId))
          .catch(() => null);
        return this.parseEligibleGroupsCacheEntry(cachedValue);
      }
    );
  }

  private async putEligibleGroupsRedisCache(
    profileId: string,
    cacheEntry: EligibleGroupsCacheEntry,
    ttlSec: number,
    timer?: Timer | undefined
  ) {
    const redisClient = getRedisClient();
    if (!redisClient) {
      return;
    }
    await this.timeAsync(
      timer,
      'getGroupsUserIsEligibleFor->redisCacheSet',
      async () => {
        await redisClient
          .set(
            this.getEligibleGroupsRedisCacheKey(profileId),
            JSON.stringify(cacheEntry),
            { EX: ttlSec }
          )
          .catch(() => undefined);
      }
    );
  }

  private async tryAcquireEligibleGroupsRedisLock(
    profileId: string,
    timer?: Timer | undefined
  ): Promise<boolean> {
    const redisClient = getRedisClient();
    if (!redisClient) {
      return true;
    }
    return await this.timeAsync(
      timer,
      'getGroupsUserIsEligibleFor->redisLockSet',
      async () => {
        const response = await redisClient
          .set(this.getEligibleGroupsRedisLockKey(profileId), '1', {
            PX: ELIGIBLE_GROUPS_REDIS_LOCK_TTL_MS,
            NX: true
          })
          .catch((err) => {
            logger.warn('Failed to acquire eligible groups Redis lock', err);
            return null;
          });
        return response === 'OK';
      }
    );
  }

  private async waitForEligibleGroupsRedisCacheEntry({
    profileId,
    latestProfileGroupChangeMillis,
    waveGroupsVersion,
    ttlSec,
    timer
  }: {
    profileId: string;
    latestProfileGroupChangeMillis: number | null;
    waveGroupsVersion: number;
    ttlSec: number;
    timer?: Timer;
  }): Promise<EligibleGroupsCacheEntry | null> {
    for (let i = 0; i < ELIGIBLE_GROUPS_REDIS_LOCK_WAIT_RETRIES; i++) {
      if (i > 0) {
        await Time.millis(ELIGIBLE_GROUPS_REDIS_LOCK_WAIT_MS).sleep();
      }
      const cacheEntry = await this.getEligibleGroupsRedisCacheEntry(
        profileId,
        timer
      );
      if (
        this.isEligibleGroupsCacheEntryValid(
          cacheEntry,
          latestProfileGroupChangeMillis,
          waveGroupsVersion
        )
      ) {
        this.putEligibleGroupsMemoryCache(profileId, cacheEntry, ttlSec);
        return cacheEntry;
      }
    }
    return null;
  }

  private parseEligibleGroupsCacheEntry(
    cachedValue: string | null
  ): EligibleGroupsCacheEntry | null {
    if (!cachedValue) {
      return null;
    }
    try {
      const parsed = JSON.parse(
        cachedValue
      ) as Partial<EligibleGroupsCacheEntry>;
      if (
        parsed &&
        Array.isArray(parsed.eligibleGroupIds) &&
        parsed.eligibleGroupIds.every((it) => typeof it === 'string') &&
        typeof parsed.computedAtMillis === 'number' &&
        Number.isFinite(parsed.computedAtMillis) &&
        typeof parsed.waveGroupsVersion === 'number' &&
        Number.isFinite(parsed.waveGroupsVersion)
      ) {
        return {
          eligibleGroupIds: parsed.eligibleGroupIds,
          computedAtMillis: parsed.computedAtMillis,
          waveGroupsVersion: parsed.waveGroupsVersion
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private isEligibleGroupsCacheEntryValid(
    cacheEntry: EligibleGroupsCacheEntry | null,
    latestProfileGroupChangeMillis: number | null,
    waveGroupsVersion: number
  ): cacheEntry is EligibleGroupsCacheEntry {
    if (!cacheEntry) {
      return false;
    }
    if (cacheEntry.waveGroupsVersion !== waveGroupsVersion) {
      return false;
    }
    return (
      latestProfileGroupChangeMillis === null ||
      cacheEntry.computedAtMillis > latestProfileGroupChangeMillis
    );
  }

  async changeVisibility(
    {
      group_id,
      old_version_id,
      visible,
      profile_id
    }: ApiChangeGroupVisibility & {
      group_id: string;
      profile_id: string;
    },
    ctx: RequestContext
  ): Promise<ApiGroupFull> {
    const { updatedGroup, replacedGroup } =
      await this.userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const groupEntity = await this.getByIdOrThrow(
            group_id,
            ctxWithConnection
          );
          let oldGroupEntity: ApiGroupFull | null = null;
          if (old_version_id) {
            if (old_version_id === groupEntity.id) {
              throw new BadRequestException(
                'Old version id should not be the same as the current'
              );
            }
            oldGroupEntity = await this.getByIdOrThrow(
              old_version_id,
              ctxWithConnection
            );
            if (oldGroupEntity.created_by?.id !== profile_id) {
              throw new BadRequestException(
                `You are not allowed to change group ${old_version_id}. You can save a new one instead.`
              );
            }
            if (
              oldGroupEntity.name !== groupEntity.name ||
              !oldGroupEntity.visible
            ) {
              await this.doNameAbusivenessCheck(groupEntity);
            }
            await this.userGroupsDb.deleteById(old_version_id, connection);
          } else {
            await this.doNameAbusivenessCheck(groupEntity);
          }
          if (groupEntity.created_by?.id !== profile_id) {
            throw new BadRequestException(
              `You are not allowed to change group ${group_id}. You can save a new one instead.`
            );
          }
          await this.userGroupsDb.changeVisibilityAndSetId(
            {
              currentId: group_id,
              newId: old_version_id,
              visibility: visible
            },
            connection
          );
          await membershipRefreshProducer.markGroupsDirty(
            [group_id, ...(old_version_id ? [old_version_id] : [])],
            MembershipRefreshReason.GROUP_CHANGED,
            ctxWithConnection
          );
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: profile_id },
            ctxWithConnection
          );
          return {
            updatedGroup: await this.getByIdOrThrow(
              old_version_id ?? group_id,
              ctxWithConnection
            ),
            replacedGroup: oldGroupEntity
          };
        }
      );
    await membershipRefreshProducer.enqueueDirtyRefreshBestEffort();
    await giveReadReplicaTimeToCatchUp();
    await this.invalidateEligibilityCachesAfterVisibilityChange(
      updatedGroup,
      replacedGroup
    );
    return updatedGroup;
  }

  /**
   * With old_version_id the updated group takes over the replaced group's id,
   * so waves referencing that id switch to the new membership. When both the
   * updated and the replaced group are plain inclusion-list groups, only
   * their listed members can gain or lose eligibility - bump exactly those
   * members instead of doing the global version bump which would invalidate
   * every profile's eligibility cache at once.
   */
  private async invalidateEligibilityCachesAfterVisibilityChange(
    updatedGroup: ApiGroupFull,
    replacedGroup: ApiGroupFull | null
  ): Promise<void> {
    const affectedGroups = [updatedGroup, replacedGroup].filter(
      (it): it is ApiGroupFull => it !== null
    );
    const allScopedToMembers = affectedGroups.every((it) =>
      this.isGroupEligibilityScopedToItsMembers(it)
    );
    if (!allScopedToMembers) {
      await clearWaveGroupsCache();
      return;
    }
    await evictWaveGroupsEntityCache();
    await this.invalidateGroupMembersEligibility(
      affectedGroups
        .map((it) => it.group.identity_group_id)
        .filter((it): it is string => it !== null)
    );
  }

  /**
   * True if the group's eligibility is fully determined by an explicit
   * inclusion list: changes around such a group cannot affect any profile
   * outside that list. Criteria groups, exclusion-only ("everyone except X")
   * groups and no-condition ("everyone") groups can affect anyone, so they
   * still require the global version bump.
   */
  private isGroupEligibilityScopedToItsMembers(group: ApiGroupFull): boolean {
    const description = group.group;
    return (
      description.identity_group_id !== null &&
      description.owns_nfts.length === 0 &&
      description.tdh.min === null &&
      description.tdh.max === null &&
      description.level.min === null &&
      description.level.max === null &&
      description.rep.min === null &&
      description.rep.max === null &&
      description.rep.user_identity === null &&
      description.rep.category === null &&
      description.cic.min === null &&
      description.cic.max === null &&
      description.cic.user_identity === null &&
      description.is_beneficiary_of_grant_id === null
    );
  }

  private async invalidateGroupMembersEligibility(
    identityGroupIds: string[]
  ): Promise<void> {
    const distinctIdentityGroupIds = collections.distinct(identityGroupIds);
    if (!distinctIdentityGroupIds.length) {
      return;
    }
    const memberProfileIdsByIdentityGroupId =
      await this.userGroupsDb.findUserGroupsIdentityGroupProfileIds(
        distinctIdentityGroupIds
      );
    const memberProfileIds = collections.distinct(
      Object.values(memberProfileIdsByIdentityGroupId).flat()
    );
    if (memberProfileIds.length) {
      await this.userGroupsDb.insertGroupChanges(memberProfileIds);
    }
  }

  /**
   * Call after a wave has been created or updated with the given group ids.
   * Groups REMOVED from a wave need no invalidation at all: eligibility
   * filters read the wave row fresh, and a group id lingering in someone's
   * cached eligible-groups list simply stops matching anything.
   */
  public async onWaveRelatedGroupsChanged(
    groupIds: (string | null | undefined)[],
    ctx: RequestContext
  ): Promise<void> {
    const distinctGroupIds = collections.distinct(
      groupIds.filter((it): it is string => !!it)
    );
    if (!distinctGroupIds.length) {
      await evictWaveGroupsEntityCache();
      return;
    }
    await membershipRefreshProducer.requestGroupsDirtyBestEffort(
      distinctGroupIds,
      MembershipRefreshReason.WAVE_GROUP_CHANGED,
      ctx
    );
    const groupEntities = await this.userGroupsDb.getByIds(
      distinctGroupIds,
      ctx
    );
    const allScopedToMembers =
      groupEntities.length === distinctGroupIds.length &&
      groupEntities.every(
        (it) =>
          it.profile_group_id !== null &&
          !hasGroupGotAnyNonIdentityConditions(it)
      );
    if (!allScopedToMembers) {
      // Unknown, criteria-based or exclusion-only group in play: profiles
      // outside any inclusion list may be affected, so keep the global bump.
      await clearWaveGroupsCache();
      return;
    }
    // Pure inclusion-list groups: non-members' eligibility is unchanged by a
    // wave (re)using them, while members need these group ids to show up in
    // their cached eligible-groups lists - a per-member bump achieves that
    // without invalidating every other profile's cache.
    await evictWaveGroupsEntityCache();
    await this.invalidateGroupMembersEligibility(
      groupEntities
        .map((it) => it.profile_group_id)
        .filter((it): it is string => it !== null)
    );
  }

  private async doNameAbusivenessCheck(groupEntity: ApiGroupFull) {
    const abusivenessDetectionResult =
      await this.abusivenessCheckService.checkFilterName({
        text: groupEntity.name,
        handle: groupEntity.created_by?.handle ?? ''
      });
    if (abusivenessDetectionResult.status !== 'ALLOWED') {
      throw new BadRequestException(
        `Group name is not allowed: ${abusivenessDetectionResult.explanation}`
      );
    }
  }

  public async getByIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ApiGroupFull> {
    ctx.timer?.start(`${this.constructor.name}->getByIdOrThrow`);
    const authenticatedUserId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const eligibleGroupIds = await this.getGroupsUserIsEligibleFor(
      authenticatedUserId,
      ctx.timer
    );
    const group = await this.userGroupsDb.getById(
      id,
      authenticatedUserId,
      eligibleGroupIds,
      ctx.connection
    );
    if (!group) {
      throw new NotFoundException(`Group with id ${id} not found`);
    }
    ctx.timer?.stop(`${this.constructor.name}->getByIdOrThrow`);
    return (await this.mapForApi([group], ctx)).at(0)!;
  }

  public async getSqlAndParamsByGroupId(
    groupId: string | null,
    ctx: RequestContext
  ): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    if (groupId === null) {
      return await this.getSqlAndParams(
        {
          cic: {
            min: null,
            max: null,
            user_identity: null,
            direction: null
          },
          rep: {
            min: null,
            max: null,
            user_identity: null,
            direction: null,
            category: null
          },
          level: {
            min: null,
            max: null
          },
          tdh: {
            min: null,
            max: null,
            inclusion_strategy: ApiGroupTdhInclusionStrategy.Tdh
          },
          owns_nfts: [],
          identity_group_id: null,
          excluded_identity_group_id: null,
          is_beneficiary_of_grant_id: null,
          is_beneficiary_of_grant_match_mode:
            ApiGroupBeneficiaryGrantMatchMode.AnyToken
        },
        null,
        ctx
      );
    } else {
      const group = await this.getByIdOrThrow(groupId, ctx);
      if (!group.visible) {
        return this.getEmptyMemberSetSql();
      }
      return await this.getSqlAndParams(group.group, groupId, ctx);
    }
  }

  public async getSqlAndParamsByGroupIdForSystemBroadcast(
    groupId: string | null,
    ctx: RequestContext
  ): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    if (groupId === null) {
      return await this.getSqlAndParamsByGroupId(groupId, ctx);
    }
    const group = await this.userGroupsDb.getByIdWithoutVisibilityCheck(
      groupId,
      ctx.connection
    );
    if (!group) {
      return null;
    }
    if (!group.visible) {
      return this.getEmptyMemberSetSql();
    }
    const apiGroup = (await this.mapForApi([group], ctx)).at(0);
    if (!apiGroup) {
      return null;
    }
    return await this.getSqlAndParams(apiGroup.group, groupId, ctx);
  }

  private async getSqlAndParams(
    group: GClean,
    group_id: string | null,
    ctx: RequestContext
  ): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    ctx.timer?.start(`${this.constructor.name}->getSqlAndParams`);
    const filterUsers = [
      group.cic.user_identity,
      group.rep.user_identity
    ].filter((user) => !!user) as string[];
    const userIds = await Promise.all(
      filterUsers.map((user) =>
        identityFetcher
          .getIdentityAndConsolidationsByIdentityKey({ identityKey: user }, ctx)
          .then((result) => result?.id ?? null)
      )
    );
    if (userIds.some((it) => it === null)) {
      return null;
    }
    const usersToUserIds = filterUsers.reduce(
      (acc, user, index) => {
        acc[user] = userIds[index]!;
        return acc;
      },
      {} as Record<string, string>
    );
    group.cic.user_identity = group.cic.user_identity
      ? usersToUserIds[group.cic.user_identity]
      : null;
    group.rep.user_identity = group.rep.user_identity
      ? usersToUserIds[group.rep.user_identity]
      : null;
    const hadLevelMaxCriterion = group.level.max !== null;
    group.level.min =
      group.level.min !== null
        ? getLevelComponentsBorderByLevel(group.level.min)
        : null;
    group.level.max =
      group.level.max !== null && group.level.max < 100
        ? getLevelComponentsBorderByLevel(group.level.max + 1)
        : null;

    const params: Record<string, any> = {};
    const beneficiaryOwnersPart = this.getBeneficiaryOwnersPart(
      group.is_beneficiary_of_grant_id,
      enums.resolve(
        GroupBeneficiaryGrantMatchMode,
        group.is_beneficiary_of_grant_match_mode
      ) ?? DEFAULT_BENEFICIARY_GRANT_MATCH_MODE,
      params
    );
    const repPart = this.getRepPart(group, params);
    const cicPart = this.getCicPart(group, params, repPart);
    const nftsPart = this.getNftsPart(
      group,
      group_id,
      params,
      repPart,
      cicPart
    );
    const cmPart = this.getGeneralPart(
      repPart,
      cicPart,
      nftsPart,
      beneficiaryOwnersPart,
      group,
      params
    );
    const inclusionExclusionPart = this.getInclusionExclusionPart(
      group,
      group_id,
      params,
      hadLevelMaxCriterion
    );
    const sql = `with ${repPart ?? ''} ${cicPart ?? ''} ${
      nftsPart ?? ''
    } ${cmPart} ${inclusionExclusionPart} `;
    ctx.timer?.stop(`${this.constructor.name}->getSqlAndParams`);
    return {
      sql,
      params
    };
  }

  private getInclusionExclusionPart(
    group: GClean,
    groupId: string | null,
    params: Record<string, any>,
    hadLevelMaxCriterion: boolean
  ): string {
    const anyOtherDescriptionButInclusion = !!(
      hadLevelMaxCriterion ||
      group.level.min !== null ||
      group.tdh.max !== null ||
      group.tdh.min !== null ||
      group.owns_nfts.length ||
      group.rep.max !== null ||
      group.rep.min !== null ||
      group.rep.user_identity ||
      group.rep.category ||
      group.cic.max !== null ||
      group.cic.min !== null ||
      group.cic.user_identity ||
      group.is_beneficiary_of_grant_id !== null
    );
    if (
      !anyOtherDescriptionButInclusion &&
      group.identity_group_id === null &&
      group.excluded_identity_group_id === null
    ) {
      const emptyGroupFilter = groupId === null ? '' : ' where false';
      return ` ${UserGroupsService.GENERATED_VIEW} as (select * from cm_view${emptyGroupFilter})`;
    }
    let sql = ` included_profile_ids as (select distinct profile_id from (${
      anyOtherDescriptionButInclusion
        ? `select i.profile_id from cm_view i`
        : group.identity_group_id === null
          ? `select i.profile_id from ${IDENTITIES_TABLE} i`
          : ``
    }`;
    if (group.identity_group_id !== null) {
      sql += ` ${
        anyOtherDescriptionButInclusion ? ` union all ` : ` `
      } select profile_id from ${PROFILE_GROUPS_TABLE} where profile_group_id = :profile_group_id `;
      params['profile_group_id'] = group.identity_group_id;
    }
    sql += `) idxs), ${
      UserGroupsService.GENERATED_VIEW
    } as (select i.* from ${IDENTITIES_TABLE} i join included_profile_ids on i.profile_id = included_profile_ids.profile_id ${
      group.excluded_identity_group_id
        ? `where included_profile_ids.profile_id not in (select exc.profile_id from ${PROFILE_GROUPS_TABLE} exc where exc.profile_group_id = :excluded_profile_group_id)`
        : ``
    }) `;
    params['excluded_profile_group_id'] = group.excluded_identity_group_id;
    return sql;
  }

  private getTypeOfNftPart({
    viewName,
    comGroupFieldName,
    tokenOwnerships,
    contract
  }: {
    viewName: string;
    comGroupFieldName: string;
    tokenOwnerships: ApiGroupOwnsNft[];
    contract: string;
  }): string | null {
    let nftPart: string | null = null;
    if (tokenOwnerships.length) {
      nftPart = ``;
      nftPart += ` ${viewName}_s1 as (select i.profile_id as profile_id, token_id
                     from ${NFT_OWNERS_TABLE} o
                              join ${ADDRESS_CONSOLIDATION_KEY} ac on ac.address = lower(wallet)
                              join ${IDENTITIES_TABLE} i on i.consolidation_key = ac.consolidation_key
                     where contract = '${contract}'), `;
      const ownsSpecificTokens =
        tokenOwnerships.map((it) => it.tokens).flat().length > 0;
      if (ownsSpecificTokens) {
        const criteriaTokensSql = `(SELECT token_id
                                             FROM community_groups,
                                                  JSON_TABLE(community_groups.${comGroupFieldName}, '$[*]'
                                                             COLUMNS (token_id VARCHAR(255) PATH '$')) AS tokens
                                             WHERE community_groups.id =
                                                   :user_group_id)`;
        const matchMode =
          enums.resolve(
            GroupNftOwnershipMatchMode,
            tokenOwnerships.find((it) => it.tokens.length > 0)?.match_mode
          ) ?? DEFAULT_NFT_OWNERSHIP_MATCH_MODE;
        if (matchMode === GroupNftOwnershipMatchMode.ANY_TOKEN) {
          nftPart += `
            ${viewName} as (SELECT distinct ${viewName}_s1.profile_id
                              FROM ${viewName}_s1
                                       JOIN ${criteriaTokensSql} AS criteria_tokens
                                            ON ${viewName}_s1.token_id = criteria_tokens.token_id)
       `;
        } else {
          nftPart += `
            ${viewName} as (SELECT profile_id
                              FROM ${viewName}_s1
                                       JOIN ${criteriaTokensSql} AS criteria_tokens
                                            ON ${viewName}_s1.token_id = criteria_tokens.token_id
                              GROUP BY profile_id
                              HAVING COUNT(DISTINCT ${viewName}_s1.token_id) = (SELECT COUNT(DISTINCT token_id)
                                                                             FROM community_groups,
                                                                                  JSON_TABLE(
                                                                                          community_groups.${comGroupFieldName},
                                                                                          '$[*]'
                                                                                          COLUMNS (token_id VARCHAR(255) PATH '$')) AS tokens
                                                                             WHERE community_groups.id = :user_group_id))
       `;
        }
      } else {
        nftPart += ` 
            ${viewName} as (SELECT distinct profile_id FROM ${viewName}_s1)
       `;
      }
    }
    return nftPart;
  }

  private getNftsPart(
    group: GClean,
    group_id: string | null,
    params: Record<string, any>,
    repPart: string | null,
    cicPart: string | null
  ): string | null {
    const memesPart = this.getTypeOfNftPart({
      viewName: 'meme_owners_of_group',
      comGroupFieldName: 'owns_meme_tokens',
      tokenOwnerships: group.owns_nfts.filter(
        (it) => it.name === ApiGroupOwnsNftNameEnum.Memes
      ),
      contract: MEMES_CONTRACT
    });
    const labsPart = this.getTypeOfNftPart({
      viewName: 'labs_owners_of_group',
      comGroupFieldName: 'owns_lab_tokens',
      tokenOwnerships: group.owns_nfts.filter(
        (it) => it.name === ApiGroupOwnsNftNameEnum.Memelab
      ),
      contract: MEMELAB_CONTRACT
    });
    const gradientsPart = this.getTypeOfNftPart({
      viewName: 'gradients_owners_of_group',
      comGroupFieldName: 'owns_gradient_tokens',
      tokenOwnerships: group.owns_nfts.filter(
        (it) => it.name === ApiGroupOwnsNftNameEnum.Gradients
      ),
      contract: GRADIENT_CONTRACT
    });
    const nextgensPart = this.getTypeOfNftPart({
      viewName: 'nextgens_owners_of_group',
      comGroupFieldName: 'owns_nextgen_tokens',
      tokenOwnerships: group.owns_nfts.filter(
        (it) => it.name === ApiGroupOwnsNftNameEnum.Nextgen
      ),
      contract: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET]
    });
    const nftsParts = [memesPart, labsPart, gradientsPart, nextgensPart].filter(
      (it) => it !== null
    );
    if (nftsParts.length === 0) {
      return null;
    }
    params['user_group_id'] = group_id;
    const nftsPart = nftsParts.join(', ');

    return ` ${repPart || cicPart ? ',' : ''} ${nftsPart}`;
  }

  private getBeneficiaryOwnersPart(
    is_beneficiary_of_grant_id: string | null,
    matchMode: GroupBeneficiaryGrantMatchMode,
    params: Record<string, any>
  ): string | null {
    if (!is_beneficiary_of_grant_id) {
      return null;
    }
    const includeGrantBeneficiaries =
      matchMode === GroupBeneficiaryGrantMatchMode.ALL_TOKENS
        ? `
      select
          i.profile_id as beneficiary_id
      from ${XTDH_GRANTS_TABLE} xg
               join ${XTDH_GRANT_TOKENS_TABLE} xtk on xg.token_mode = '${XTdhGrantTokenMode.INCLUDE}' and xtk.tokenset_id = xg.tokenset_id and xtk.target_partition = xg.target_partition
               join ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} eto on eto.\`partition\` = xg.target_partition and eto.token_id = xtk.token_id
               join ${ADDRESS_CONSOLIDATION_KEY} ack on ack.address = eto.owner
               join ${IDENTITIES_TABLE} i on i.consolidation_key = ack.consolidation_key
      where xg.status = '${XTdhGrantStatus.GRANTED}' and xg.token_mode = '${XTdhGrantTokenMode.INCLUDE}'
        and xg.id = :is_beneficiary_of_grant_id
      group by i.profile_id, xg.tokenset_id, xg.target_partition
      having count(distinct eto.token_id) = (
        select count(distinct all_tokens.token_id)
        from ${XTDH_GRANT_TOKENS_TABLE} all_tokens
        where all_tokens.tokenset_id = xg.tokenset_id
          and all_tokens.target_partition = xg.target_partition
      )
      `
        : `
      select
          distinct i.profile_id as beneficiary_id
      from ${XTDH_GRANTS_TABLE} xg
               join ${XTDH_GRANT_TOKENS_TABLE} xtk on xg.token_mode = '${XTdhGrantTokenMode.INCLUDE}' and xtk.tokenset_id = xg.tokenset_id and xtk.target_partition = xg.target_partition
               join ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} eto on eto.\`partition\` = xg.target_partition and eto.token_id = xtk.token_id
               join ${ADDRESS_CONSOLIDATION_KEY} ack on ack.address = eto.owner
               join ${IDENTITIES_TABLE} i on i.consolidation_key = ack.consolidation_key
      where xg.status = '${XTdhGrantStatus.GRANTED}' and xg.token_mode = '${XTdhGrantTokenMode.INCLUDE}'
        and xg.id = :is_beneficiary_of_grant_id
      `;
    const beneficiariesPart = `
      beneficiaries as (select
          distinct i.profile_id as beneficiary_id
      from ${ADDRESS_CONSOLIDATION_KEY} a
               join ${IDENTITIES_TABLE} i on a.consolidation_key = i.consolidation_key
               join ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} eto on eto.owner = a.address
               join ${XTDH_GRANTS_TABLE} xg on xg.target_partition = eto.\`partition\`
      where xg.status = '${XTdhGrantStatus.GRANTED}' and xg.token_mode = '${XTdhGrantTokenMode.ALL}'
        and xg.id = :is_beneficiary_of_grant_id
        ${
          matchMode === GroupBeneficiaryGrantMatchMode.ANY_TOKEN
            ? ''
            : 'and 1 = 0'
        }
      union all
      ${includeGrantBeneficiaries})
    `;
    params['is_beneficiary_of_grant_id'] = is_beneficiary_of_grant_id;
    return beneficiariesPart;
  }

  private getGeneralPart(
    repPart: string | null,
    cicPart: string | null,
    nftsPart: string | null,
    beneficiariesPart: string | null,
    group: GClean,
    params: Record<string, any>
  ) {
    let cmPart = ` ${repPart || cicPart || nftsPart ? ', ' : ' '}`;
    if (beneficiariesPart) {
      cmPart = ` ${beneficiariesPart}, ${cmPart} `;
    }
    cmPart += ` cm_view as (select i.* from ${IDENTITIES_TABLE} i `;
    if (repPart !== null) {
      cmPart += `join rep_exchanges on i.profile_id = rep_exchanges.profile_id `;
    }
    if (cicPart !== null) {
      cmPart += `join cic_exchanges on i.profile_id = cic_exchanges.profile_id `;
    }
    if (beneficiariesPart) {
      cmPart += ` join beneficiaries b on b.beneficiary_id = i.profile_id `;
    }
    const {
      joinMemeOwnerships,
      joinLabOwnerships,
      joinNextgenOwnerships,
      joinGradientOwnerships
    } = group.owns_nfts.reduce(
      (acc, it) => {
        if (it.name === ApiGroupOwnsNftNameEnum.Memes) {
          acc.joinMemeOwnerships = true;
        } else if (it.name === ApiGroupOwnsNftNameEnum.Memelab) {
          acc.joinLabOwnerships = true;
        } else if (it.name === ApiGroupOwnsNftNameEnum.Gradients) {
          acc.joinGradientOwnerships = true;
        } else if (it.name === ApiGroupOwnsNftNameEnum.Nextgen) {
          acc.joinNextgenOwnerships = true;
        }
        return acc;
      },
      {
        joinMemeOwnerships: false,
        joinLabOwnerships: false,
        joinGradientOwnerships: false,
        joinNextgenOwnerships: false
      }
    );
    if (joinMemeOwnerships) {
      cmPart += ` join meme_owners_of_group on i.profile_id = meme_owners_of_group.profile_id `;
    }
    if (joinLabOwnerships) {
      cmPart += ` join labs_owners_of_group on i.profile_id = labs_owners_of_group.profile_id `;
    }
    if (joinGradientOwnerships) {
      cmPart += ` join gradients_owners_of_group on i.profile_id = gradients_owners_of_group.profile_id `;
    }
    if (joinNextgenOwnerships) {
      cmPart += ` join nextgens_owners_of_group on i.profile_id = nextgens_owners_of_group.profile_id `;
    }
    cmPart += ` where true `;
    const tdhInclusionStrategy = enums.resolveOrThrow(
      GroupTdhInclusionStrategy,
      group.tdh.inclusion_strategy
    );
    const identitySideTdhPart = this.getIdentitySideTdhPart(
      'i',
      tdhInclusionStrategy
    );
    if (group.tdh.min !== null) {
      cmPart += `and ${identitySideTdhPart} >= :tdh_min `;
      params.tdh_min = group.tdh.min;
    }
    if (group.tdh.max !== null) {
      cmPart += `and ${identitySideTdhPart} <= :tdh_max `;
      params.tdh_max = group.tdh.max;
    }
    if (group.level.min !== null) {
      cmPart += `and i.level_raw >= :level_min `;
      params.level_min = group.level.min;
    }
    if (group.level.max !== null) {
      cmPart += `and i.level_raw < :level_max `;
      params.level_max = group.level.max;
    }
    cmPart += '), ';
    return cmPart;
  }

  private getCicPart(
    group: GClean,
    params: Record<string, any>,
    repPart: string | null
  ) {
    const cicGroup = group.cic;
    let cicPart = null;
    if (
      cicGroup.user_identity !== null ||
      cicGroup.min !== null ||
      cicGroup.max !== null
    ) {
      const direction = cicGroup.direction ?? ApiGroupFilterDirection.Received;
      if (cicGroup.user_identity) {
        params.cic_user = cicGroup.user_identity;
      }
      const profileColumn =
        direction === ApiGroupFilterDirection.Received
          ? 'matter_target_id'
          : 'rater_profile_id';
      const counterpartyColumn =
        direction === ApiGroupFilterDirection.Received
          ? 'rater_profile_id'
          : 'matter_target_id';
      let groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${profileColumn} as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC'`;
      if (cicGroup.user_identity !== null) {
        groupedCicQuery += ` and ${counterpartyColumn} = :cic_user`;
      }
      groupedCicQuery += ` group by 1)`;
      cicPart = `${groupedCicQuery}, cic_exchanges as (select i.profile_id from ${IDENTITIES_TABLE} i left join grouped_cics c on c.profile_id = i.profile_id where true `;
      if (cicGroup.max !== null) {
        cicPart += `and coalesce(c.rating, 0) <= :cic_amount_max `;
        params.cic_amount_max = cicGroup.max;
      }
      if (cicGroup.min !== null) {
        cicPart += `and coalesce(c.rating, 0) >= :cic_amount_min `;
        params.cic_amount_min = cicGroup.min;
      }
      if (
        cicGroup.user_identity !== null &&
        cicGroup.min === null &&
        cicGroup.max === null
      ) {
        cicPart += `and coalesce(c.rating, 0) <> 0 `;
      }
      cicPart += `) `;
    }
    return cicPart;
  }

  private getRepPart(group: GClean, params: Record<string, any>) {
    let repPart = null;
    const repGroup = group.rep;
    if (
      repGroup.category !== null ||
      repGroup.user_identity !== null ||
      repGroup.max !== null ||
      repGroup.min !== null
    ) {
      const direction = repGroup.direction ?? ApiGroupFilterDirection.Received;
      if (repGroup.user_identity) {
        params.rep_user = repGroup.user_identity;
      }
      const profileColumn =
        direction === ApiGroupFilterDirection.Received
          ? 'matter_target_id'
          : 'rater_profile_id';
      const counterpartyColumn =
        direction === ApiGroupFilterDirection.Received
          ? 'rater_profile_id'
          : 'matter_target_id';
      let groupedRepQuery = `grouped_reps as (select ${profileColumn} as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP'`;
      if (repGroup.user_identity !== null) {
        groupedRepQuery += ` and ${counterpartyColumn} = :rep_user`;
      }
      if (repGroup.category !== null) {
        groupedRepQuery += ` and matter_category = :rep_category`;
        params.rep_category = repGroup.category;
      }
      groupedRepQuery += ` group by 1)`;
      repPart = `${groupedRepQuery}, rep_exchanges as (select i.profile_id from ${IDENTITIES_TABLE} i left join grouped_reps r on r.profile_id = i.profile_id where true `;
      if (repGroup.max !== null) {
        repPart += `and coalesce(r.rating, 0) <= :rep_amount_max `;
        params.rep_amount_max = repGroup.max;
      }
      if (repGroup.min !== null) {
        repPart += `and coalesce(r.rating, 0) >= :rep_amount_min `;
        params.rep_amount_min = repGroup.min;
      }
      if (
        (repGroup.user_identity !== null || repGroup.category !== null) &&
        repGroup.min === null &&
        repGroup.max === null
      ) {
        repPart += `and coalesce(r.rating, 0) <> 0 `;
      }
      repPart += `) `;
    }
    return repPart;
  }

  async searchByNameOrAuthor(
    name: string | null,
    authorId: string | null,
    createdAtLessThan: number | null,
    includeProfileGroups: boolean,
    ctx: RequestContext
  ): Promise<ApiGroupFull[]> {
    ctx.timer?.start('userGroupsService->searchByNameOrAuthor');
    const authenticatedUserId =
      ctx.authenticationContext?.getActingAsId() ?? null;
    const eligibleGroupIds = await this.getGroupsUserIsEligibleFor(
      authenticatedUserId,
      ctx?.timer
    );

    const group = await this.userGroupsDb.searchByNameOrAuthor(
      name,
      authorId,
      createdAtLessThan,
      includeProfileGroups,
      authenticatedUserId,
      eligibleGroupIds,
      ctx
    );
    const result = await this.mapForApi(group, ctx);
    ctx.timer?.stop('userGroupsService->searchByNameOrAuthor');
    return result;
  }

  async getByIds(
    ids: string[],
    ctx: RequestContext
  ): Promise<UserGroupEntity[]> {
    return await this.userGroupsDb.getByIds(ids, ctx);
  }

  async findUserGroupsIdentityGroupIdentities(
    identityGroupId: string
  ): Promise<string[]> {
    return await this.userGroupsDb.findUserGroupsIdentityGroupPrimaryAddresses(
      identityGroupId
    );
  }

  async findUserGroupsIdentityGroupProfileIds(
    identityGroupIds: string[]
  ): Promise<Record<string, string[]>> {
    return await this.userGroupsDb.findUserGroupsIdentityGroupProfileIds(
      identityGroupIds
    );
  }

  private async mapForApi(
    groups: UserGroupEntity[],
    ctx: RequestContext
  ): Promise<ApiGroupFull[]> {
    ctx.timer?.start('userGroupsService->mapForApi');
    const relatedProfiles = await identityFetcher.getOverviewsByIds(
      collections.distinct(
        groups
          .map(
            (it) =>
              [it.created_by, it.rep_user, it.cic_user].filter(
                (it) => !!it
              ) as string[]
          )
          .flat()
      ),
      ctx
    );
    const groupsIdentityGroupsIdsAndIdentityCounts: Record<
      string,
      {
        identity_group_id: string | null;
        identity_count: number;
        excluded_identity_group_id: string | null;
        excluded_identity_count: number;
      }
    > =
      await this.userGroupsDb.findIdentityGroupsIdsAndIdentityCountsByGroupIds(
        groups.map((it) => it.id),
        ctx
      );
    const grantsModels = await xTdhGrantsFinder.getGrantsByIds(
      groups
        .map((it) => it.is_beneficiary_of_grant_id)
        .filter((it) => !!it) as string[],
      ctx
    );
    const grantsApiModels =
      await xTdhGrantApiConverter.fromXTdhGrantModelsToApiXTdhGrants(
        grantsModels,
        ctx
      );
    const result = groups.map<ApiGroupFull>((it) => ({
      id: it.id,
      name: it.name,
      visible: it.visible,
      is_private: !!it.is_private,
      created_at: new Date(it.created_at).getTime(),
      group: {
        cic: {
          min: it.cic_min,
          max: it.cic_max,
          direction: it.cic_direction
            ? enums.resolve(ApiGroupFilterDirection, it.cic_direction)!
            : null,
          user_identity: it.cic_user
            ? (relatedProfiles[it.cic_user]?.handle ?? it.cic_user)
            : null
        },
        rep: {
          min: it.rep_min,
          max: it.rep_max,
          direction: it.rep_direction
            ? enums.resolve(ApiGroupFilterDirection, it.rep_direction)!
            : null,
          user_identity: it.rep_user
            ? (relatedProfiles[it.rep_user]?.handle ?? it.rep_user)
            : null,
          category: it.rep_category
        },
        level: {
          min: it.level_min,
          max: it.level_max
        },
        tdh: {
          min: it.tdh_min,
          max: it.tdh_max,
          inclusion_strategy: enums.resolveOrThrow(
            ApiGroupTdhInclusionStrategy,
            it.tdh_inclusion_strategy
          )
        },
        owns_nfts: [
          it.owns_meme
            ? {
                name: ApiGroupOwnsNftNameEnum.Memes,
                tokens: it.owns_meme_tokens
                  ? JSON.parse(it.owns_meme_tokens)
                  : [],
                match_mode: enums.resolveOrThrow(
                  ApiGroupNftOwnershipMatchMode,
                  it.owns_meme_tokens_match_mode ??
                    DEFAULT_NFT_OWNERSHIP_MATCH_MODE
                )
              }
            : null,
          it.owns_gradient
            ? {
                name: ApiGroupOwnsNftNameEnum.Gradients,
                tokens: it.owns_gradient_tokens
                  ? JSON.parse(it.owns_gradient_tokens)
                  : [],
                match_mode: enums.resolveOrThrow(
                  ApiGroupNftOwnershipMatchMode,
                  it.owns_gradient_tokens_match_mode ??
                    DEFAULT_NFT_OWNERSHIP_MATCH_MODE
                )
              }
            : null,
          it.owns_nextgen
            ? {
                name: ApiGroupOwnsNftNameEnum.Nextgen,
                tokens: it.owns_nextgen_tokens
                  ? JSON.parse(it.owns_nextgen_tokens)
                  : [],
                match_mode: enums.resolveOrThrow(
                  ApiGroupNftOwnershipMatchMode,
                  it.owns_nextgen_tokens_match_mode ??
                    DEFAULT_NFT_OWNERSHIP_MATCH_MODE
                )
              }
            : null,
          it.owns_lab
            ? {
                name: ApiGroupOwnsNftNameEnum.Memelab,
                tokens: it.owns_lab_tokens
                  ? JSON.parse(it.owns_lab_tokens)
                  : [],
                match_mode: enums.resolveOrThrow(
                  ApiGroupNftOwnershipMatchMode,
                  it.owns_lab_tokens_match_mode ??
                    DEFAULT_NFT_OWNERSHIP_MATCH_MODE
                )
              }
            : null
        ].filter((it) => !!it) as ApiGroupOwnsNft[],
        identity_group_id:
          groupsIdentityGroupsIdsAndIdentityCounts[it.id]?.identity_group_id ??
          null,
        identity_group_identities_count:
          groupsIdentityGroupsIdsAndIdentityCounts[it.id]?.identity_count ?? 0,
        excluded_identity_group_id:
          groupsIdentityGroupsIdsAndIdentityCounts[it.id]
            ?.excluded_identity_group_id ?? null,
        excluded_identity_group_identities_count:
          groupsIdentityGroupsIdsAndIdentityCounts[it.id]
            ?.excluded_identity_count ?? 0,
        is_beneficiary_of_grant_id: it.is_beneficiary_of_grant_id,
        is_beneficiary_of_grant_match_mode: enums.resolveOrThrow(
          ApiGroupBeneficiaryGrantMatchMode,
          it.is_beneficiary_of_grant_match_mode ??
            DEFAULT_BENEFICIARY_GRANT_MATCH_MODE
        ),
        is_beneficiary_of_grant:
          grantsApiModels.find((g) => g.id === it.is_beneficiary_of_grant_id) ??
          null
      },
      created_by: relatedProfiles[it.created_by] ?? null
    }));
    ctx.timer?.stop('userGroupsService->mapForApi');
    return result;
  }

  async findFollowersOfUserInGroups(
    userId: string,
    groups: string[],
    ctx: RequestContext
  ): Promise<string[]> {
    return await this.userGroupsDb.findFollowersOfUserInGroups(
      userId,
      groups,
      ctx
    );
  }

  async findIdentitiesInGroups(
    groupIds: string[],
    ctx: RequestContext
  ): Promise<string[]> {
    return await this.userGroupsDb.findIdentitiesInGroups(groupIds, ctx);
  }

  private getIdentitySideTdhPart(
    identityAlias: string,
    tdhInclusionStrategy: GroupTdhInclusionStrategy
  ): string {
    switch (tdhInclusionStrategy) {
      case GroupTdhInclusionStrategy.TDH:
        return `${identityAlias}.tdh`;
      case GroupTdhInclusionStrategy.XTDH:
        return `floor(${identityAlias}.xtdh)`;
      case GroupTdhInclusionStrategy.BOTH:
        return `floor(${identityAlias}.tdh + ${identityAlias}.xtdh)`;
      default:
        return assertUnreachable(tdhInclusionStrategy);
    }
  }

  private getEmptyMemberSetSql(): {
    sql: string;
    params: Record<string, never>;
  } {
    return {
      sql: `with ${UserGroupsService.GENERATED_VIEW} as (select * from ${IDENTITIES_TABLE} where false)`,
      params: {}
    };
  }
}

export const userGroupsService = new UserGroupsService(
  userGroupsDb,
  abusivenessCheckService,
  metricsRecorder
);
