import {
  ADDRESS_CONSOLIDATION_KEY,
  GRADIENT_CONTRACT,
  IDENTITIES_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE
} from '../../../constants';
import {
  getLevelComponentsBorderByLevel,
  getLevelFromScore
} from '../../../profiles/profile-level';
import { UserGroupEntity } from '../../../entities/IUserGroup';
import {
  userGroupsDb,
  UserGroupsDb
} from '../../../user-groups/user-groups.db';
import slugify from 'slugify';
import { distinct, uniqueShortId } from '../../../helpers';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import {
  abusivenessCheckService,
  AbusivenessCheckService
} from '../../../profiles/abusiveness-check.service';
import { RateMatter } from '../../../entities/IRating';
import { ApiChangeGroupVisibility } from '../generated/models/ApiChangeGroupVisibility';
import { ApiGroupFull } from '../generated/models/ApiGroupFull';
import { ApiGroupFilterDirection } from '../generated/models/ApiGroupFilterDirection';
import { ApiGroupDescription } from '../generated/models/ApiGroupDescription';
import {
  ApiGroupOwnsNft,
  ApiGroupOwnsNftNameEnum
} from '../generated/models/ApiGroupOwnsNft';
import { Time, Timer } from '../../../time';
import * as mcache from 'memory-cache';
import { RequestContext } from '../../../request.context';
import { NEXTGEN_CORE_CONTRACT } from '../../../nextgen/nextgen_constants';
import { Network } from 'alchemy-sdk';
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
} from '../../../groups/user-group-predicates';
import { identityFetcher } from '../identities/identity.fetcher';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { identitiesDb } from '../../../identities/identities.db';
import { enums } from '../../../enums';

export type NewUserGroupEntity = Omit<
  UserGroupEntity,
  'id' | 'created_at' | 'created_by'
>;

export class UserGroupsService {
  public static readonly GENERATED_VIEW = 'user_groups_view';

  constructor(
    private readonly userGroupsDb: UserGroupsDb,
    private readonly abusivenessCheckService: AbusivenessCheckService
  ) {}

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
            uniqueShortId();
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
          return await this.getByIdOrThrow(id, ctxWithConnection);
        }
      );
    await giveReadReplicaTimeToCatchUp();
    this.invalidateGroupsUserIsEligibleFor(createdBy);
    return savedEntity;
  }

  public async findOrCreateDirectMessageGroup(
    creatorProfile: ApiIdentity,
    identityAddresses: string[],
    ctx: RequestContext
  ): Promise<ApiGroupFull> {
    const existingGroup = await this.userGroupsDb.findDirectMessageGroup(
      [creatorProfile.primary_wallet, ...identityAddresses],
      ctx
    );
    if (existingGroup) {
      return (await this.mapForApi([existingGroup], ctx))[0];
    }
    const handles = await identitiesDb.getHandlesByPrimaryWallets(
      identityAddresses,
      ctx.connection
    );
    if (handles.length !== identityAddresses.length) {
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
      level_min: null,
      level_max: null,
      owns_meme: false,
      owns_gradient: false,
      owns_lab: false,
      owns_nextgen: false,
      owns_meme_tokens: null,
      owns_gradient_tokens: null,
      owns_lab_tokens: null,
      owns_nextgen_tokens: null,
      addresses: [creatorProfile.primary_wallet, ...identityAddresses],
      excluded_addresses: [],
      visible: true,
      is_private: true,
      is_direct_message: true
    };

    return await this.save(userGroup, creatorProfile.id!, ctx, true);
  }

  public async whichOfGivenGroupsIsUserEligibleFor(
    {
      profileId,
      givenGroups
    }: {
      profileId: string;
      givenGroups: string[];
    },
    timer?: Timer
  ): Promise<string[]> {
    if (!givenGroups.length) {
      return [];
    }
    const identityEntity = await this.userGroupsDb.getIdentityByProfileId(
      profileId
    );
    if (!identityEntity) {
      return [];
    }
    const profile: ProfileSimpleMetrics = {
      profile_id: identityEntity.profile_id!,
      rep: identityEntity.rep,
      cic: identityEntity.cic,
      tdh: identityEntity.tdh,
      level: getLevelFromScore(identityEntity.level_raw)
    };
    const givenGroupEntities = await this.userGroupsDb.getByIds(givenGroups, {
      timer
    });
    if (!givenGroupEntities.length) {
      return [];
    }
    const { groupsWhereUserIsInByIdentity, groupsInNeedOfAdditionalCheck } =
      await this.eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck(
        givenGroupEntities,
        profile
      );

    const groupEntitiesWhichPassedAllChecks =
      await this.eliminateGroupsBySimpleMetricsViolations(
        groupsInNeedOfAdditionalCheck,
        profile
      )
        .then((groups) =>
          this.eliminateGroupsByFullOutgoingCicAndRep(groups, profile)
        )
        .then((groups) => this.eliminateGroupsByOwnings(groups, profile))
        .then((groups) =>
          this.eliminateGroupsByGranularRatings(groups, profile)
        );
    return [
      ...groupEntitiesWhichPassedAllChecks.map((it) => it.id),
      ...groupsWhereUserIsInByIdentity.map((it) => it.id)
    ];
  }

  private async eliminateGroupsByGranularRatings(
    groups: UserGroupEntity[],
    profile: ProfileSimpleMetrics
  ) {
    const { users, categories } =
      this.extractAllCicRepUsersAndCategoriesFromGroups(groups);
    if (users.length !== 0 || categories.length !== 0) {
      const { outgoingRatings, incomingRatings } =
        await this.getIncomingOutgoingGroupedRatings(
          profile,
          users,
          categories
        );
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
    return groups;
  }

  private async getIncomingOutgoingGroupedRatings(
    profile: ProfileSimpleMetrics,
    users: string[],
    categories: string[]
  ) {
    const ratings = await this.userGroupsDb.getRatings(
      profile.profile_id,
      users,
      categories
    );
    const { outgoingRatings, incomingRatings } = ratings.reduce(
      (acc, rating) => {
        if (rating.rater_profile_id === profile.profile_id) {
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
        incomingRatings: {
          other_side_id: string;
          matter: RateMatter;
          matter_category: string;
          rating: number;
        }[];
        outgoingRatings: {
          other_side_id: string;
          matter: RateMatter;
          matter_category: string;
          rating: number;
        }[];
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

  private async eliminateGroupsByOwnings(
    groups: UserGroupEntity[],
    profile: ProfileSimpleMetrics
  ): Promise<UserGroupEntity[]> {
    if (isAnyGroupByOwningsCriteria(groups)) {
      const ownings =
        await this.userGroupsDb.getAllProfileOwnedTokensByProfileIdGroupedByContract(
          profile.profile_id,
          {}
        );
      return groups.filter(
        (entity) => !isProfileViolatingOwnsCriteria(entity, ownings)
      );
    }
    return groups;
  }

  private async eliminateGroupsByFullOutgoingCicAndRep(
    groups: UserGroupEntity[],
    profile: ProfileSimpleMetrics
  ): Promise<UserGroupEntity[]> {
    if (isAnyGroupByTotalSentCicOrRepCriteria(groups)) {
      const { cic, rep } = await this.userGroupsDb.getGivenCicAndRep(
        profile.profile_id
      );
      return groups.filter(
        (entity) =>
          !isProfileViolatingTotalSentCicCriteria(cic, entity) &&
          !isProfileViolatingTotalSentRepCriteria(rep, entity)
      );
    }
    return groups;
  }

  private async eliminateGroupsBySimpleMetricsViolations(
    groups: UserGroupEntity[],
    profile: ProfileSimpleMetrics
  ): Promise<UserGroupEntity[]> {
    return groups.filter(
      (entity) =>
        !isProfileViolatingGroupsProfileTdhCriteria(profile, entity) &&
        !isProfileViolatingGroupsProfileLevelCriteria(profile, entity) &&
        !isProfileViolatingGroupsProfileCicCriteria(profile, entity) &&
        !isProfileViolatingGroupsProfileRepCriteria(profile, entity)
    );
  }

  private async eliminateBannedGroupsAndGroupRestByInByIdentityAndNeedsAdditionalCheck(
    groups: UserGroupEntity[],
    profile: {
      profile_id: string;
      tdh: number;
      level: number;
      cic: number;
      rep: number;
    }
  ): Promise<{
    groupsWhereUserIsInByIdentity: UserGroupEntity[];
    groupsInNeedOfAdditionalCheck: UserGroupEntity[];
  }> {
    const [
      groupsIdsUserIsEligibleByIdentity,
      groupIdsUserIsBannedFromByIdentity
    ] = await Promise.all([
      this.userGroupsDb.getGroupsUserIsEligibleByIdentity({
        profileId: profile.profile_id,
        givenGroups: groups.map((it) => it.id)
      }),
      this.userGroupsDb.getGroupsUserIsExcludedFromByIdentity({
        profileId: profile.profile_id,
        givenGroups: groups.map((it) => it.id)
      })
    ]);

    const nonBannedGroups = groups.filter(
      (it) => !groupIdsUserIsBannedFromByIdentity.includes(it.id)
    );

    const groupsWhereUserIsInByIdentity = nonBannedGroups.filter((it) =>
      groupsIdsUserIsEligibleByIdentity.includes(it.id)
    );
    const groupsInNeedOfAdditionalCheck = nonBannedGroups
      .filter((it) => hasGroupGotAnyNonIdentityConditions(it))
      .filter((it) => !groupsIdsUserIsEligibleByIdentity.includes(it.id));
    return {
      groupsWhereUserIsInByIdentity: groupsWhereUserIsInByIdentity,
      groupsInNeedOfAdditionalCheck: groupsInNeedOfAdditionalCheck
    };
  }

  public invalidateGroupsUserIsEligibleFor(profileId: string) {
    const key = `eligible-groups-${profileId}`;
    mcache.del(key);
  }

  public async getGroupsUserIsEligibleFor(
    profileId: string | null,
    timer?: Timer
  ): Promise<string[]> {
    if (!profileId) {
      return [];
    }
    const key = `eligible-groups-${profileId}`;
    const cachedGroupsUserIsEligibleFor = mcache.get(key);
    if (cachedGroupsUserIsEligibleFor) {
      return cachedGroupsUserIsEligibleFor;
    }
    const timerKey = 'getGroupsUserIsEligibleFor';
    timer?.start(timerKey);
    const groups = await this.userGroupsDb.getAllWaveRelatedGroups({ timer });
    const results = await this.whichOfGivenGroupsIsUserEligibleFor(
      { profileId, givenGroups: groups },
      timer
    );
    mcache.put(key, results, Time.minutes(1).toMillis());
    timer?.stop(timerKey);
    return results;
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
    const updatedGroupEntity =
      await this.userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const groupEntity = await this.getByIdOrThrow(
            group_id,
            ctxWithConnection
          );
          if (old_version_id) {
            if (old_version_id === groupEntity.id) {
              throw new BadRequestException(
                'Old version id should not be the same as the current'
              );
            }
            const oldGroupEntity = await this.getByIdOrThrow(
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
          return await this.getByIdOrThrow(
            old_version_id ?? group_id,
            ctxWithConnection
          );
        }
      );
    await giveReadReplicaTimeToCatchUp();
    return updatedGroupEntity;
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
            max: null
          },
          owns_nfts: [],
          identity_group_id: null,
          excluded_identity_group_id: null
        },
        null,
        ctx
      );
    } else {
      const group = await this.getByIdOrThrow(groupId, ctx);
      return await this.getSqlAndParams(group.group, groupId, ctx);
    }
  }

  private async getSqlAndParams(
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
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
    const usersToUserIds = filterUsers.reduce((acc, user, index) => {
      acc[user] = userIds[index]!;
      return acc;
    }, {} as Record<string, string>);
    group.cic.user_identity = group.cic.user_identity
      ? usersToUserIds[group.cic.user_identity]
      : null;
    group.rep.user_identity = group.rep.user_identity
      ? usersToUserIds[group.rep.user_identity]
      : null;
    group.level.min = group.level.min
      ? getLevelComponentsBorderByLevel(group.level.min)
      : null;
    group.level.max = group.level.max
      ? getLevelComponentsBorderByLevel(group.level.max)
      : null;

    const params: Record<string, any> = {};
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
      group,
      params
    );
    const inclusionExclusionPart = this.getInclusionExclusionPart(
      group,
      params
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
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
    params: Record<string, any>
  ): string {
    const anyOtherDescriptionButInclusion = !!(
      group.level.max !== null ||
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
      group.cic.user_identity
    );
    if (
      !anyOtherDescriptionButInclusion &&
      group.identity_group_id === null &&
      group.excluded_identity_group_id === null
    ) {
      return ` ${UserGroupsService.GENERATED_VIEW} as (select * from cm_view)`;
    }
    let sql = ` included_profile_ids as (select distinct profile_id from (${
      anyOtherDescriptionButInclusion
        ? `select i.profile_id from cm_view i`
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
        nftPart += ` 
            ${viewName} as (SELECT profile_id
                              FROM ${viewName}_s1
                                       JOIN (SELECT token_id
                                             FROM community_groups,
                                                  JSON_TABLE(community_groups.${comGroupFieldName}, '$[*]'
                                                             COLUMNS (token_id VARCHAR(255) PATH '$')) AS tokens
                                             WHERE community_groups.id =
                                                   :user_group_id) AS criteria_tokens
                                            ON ${viewName}_s1.token_id = criteria_tokens.token_id
                              GROUP BY profile_id
                              HAVING COUNT(DISTINCT ${viewName}_s1.token_id) = (SELECT COUNT(*)
                                                                             FROM community_groups,
                                                                                  JSON_TABLE(
                                                                                          community_groups.${comGroupFieldName},
                                                                                          '$[*]'
                                                                                          COLUMNS (token_id VARCHAR(255) PATH '$')) AS tokens
                                                                             WHERE community_groups.id = :user_group_id))
       `;
      } else {
        nftPart += ` 
            ${viewName} as (SELECT distinct profile_id FROM ${viewName}_s1)
       `;
      }
    }
    return nftPart;
  }

  private getNftsPart(
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
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

  private getGeneralPart(
    repPart: string | null,
    cicPart: string | null,
    nftsPart: string | null,
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
    params: Record<string, any>
  ) {
    let cmPart = ` ${repPart || cicPart || nftsPart ? ', ' : ' '}`;
    cmPart += ` cm_view as (select i.* from ${IDENTITIES_TABLE} i `;
    if (repPart !== null) {
      cmPart += `join rep_exchanges on i.profile_id = rep_exchanges.profile_id `;
    }
    if (cicPart !== null) {
      cmPart += `join cic_exchanges on i.profile_id = cic_exchanges.profile_id `;
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
    if (group.tdh.min !== null) {
      cmPart += `and i.tdh >= :tdh_min `;
      params.tdh_min = group.tdh.min;
    }
    if (group.tdh.max !== null) {
      cmPart += `and i.tdh <= :tdh_max `;
      params.tdh_max = group.tdh.max;
    }
    if (group.level.min !== null) {
      cmPart += `and i.level_raw >= :level_min `;
      params.level_min = group.level.min;
    }
    if (group.level.max !== null) {
      cmPart += `and i.level_raw <= :level_max `;
      params.level_max = group.level.max;
    }
    cmPart += '), ';
    return cmPart;
  }

  private getCicPart(
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
    params: Record<string, any>,
    repPart: string | null
  ) {
    const cicGroup = group.cic;
    let cicPart = null;
    if (cicGroup.user_identity || cicGroup.min || cicGroup.max) {
      const direction = cicGroup.user_identity
        ? cicGroup.direction ?? ApiGroupFilterDirection.Received
        : ApiGroupFilterDirection.Received;
      if (cicGroup.user_identity) {
        params.cic_user = cicGroup.user_identity;
      }
      let groupedCicQuery;
      if (cicGroup.user_identity !== null) {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, rating from ${RATINGS_TABLE} where matter = 'CIC' and rating <> 0 and ${
          direction === ApiGroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :cic_user)`;
        params.cic_user = cicGroup.user_identity;
      } else {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC' and rating <> 0 group by 1)`;
      }
      cicPart = `${groupedCicQuery}, cic_exchanges as (select profile_id from grouped_cics where true `;
      if (cicGroup.max !== null) {
        cicPart += `and rating <= :cic_amount_max `;
        params.cic_amount_max = cicGroup.max;
      }
      if (cicGroup.min !== null) {
        cicPart += `and rating >= :cic_amount_min `;
        params.cic_amount_min = cicGroup.min;
      }
      cicPart += `) `;
    }
    return cicPart;
  }

  private getRepPart(
    group: Omit<
      ApiGroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
    params: Record<string, any>
  ) {
    let repPart = null;
    const repGroup = group.rep;
    if (
      repGroup.category ||
      repGroup.user_identity ||
      repGroup.max ||
      repGroup.min
    ) {
      const direction = repGroup.direction ?? ApiGroupFilterDirection.Received;
      if (repGroup.user_identity) {
        params.rep_user = repGroup.user_identity;
      }
      let groupedRepQuery: string;
      if (repGroup.user_identity !== null && repGroup.category !== null) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 and ${
          direction === ApiGroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user)`;
      } else if (
        repGroup.user_identity !== null &&
        repGroup.category === null
      ) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 and ${
          direction === ApiGroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user group by 1, 2)`;
      } else if (
        repGroup.user_identity === null &&
        repGroup.category !== null
      ) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 group by 1, 2)`;
      } else {
        groupedRepQuery = `grouped_reps as (select ${
          direction === ApiGroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, null as matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 group by 1, 2)`;
      }

      repPart = `${groupedRepQuery}, rep_exchanges as (select distinct profile_id from grouped_reps where true `;
      if (repGroup.category !== null) {
        repPart += `and matter_category = :rep_category `;
        params.rep_category = repGroup.category;
      }
      if (repGroup.max !== null) {
        repPart += `and rating <= :rep_amount_max `;
        params.rep_amount_max = repGroup.max;
      }
      if (repGroup.min !== null) {
        repPart += `and rating >= :rep_amount_min `;
        params.rep_amount_min = repGroup.min;
      }
      repPart += `) `;
    }
    return repPart;
  }

  async searchByNameOrAuthor(
    name: string | null,
    authorId: string | null,
    createdAtLessThan: number | null,
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

  private async mapForApi(
    groups: UserGroupEntity[],
    ctx: RequestContext
  ): Promise<ApiGroupFull[]> {
    ctx.timer?.start('userGroupsService->mapForApi');
    const relatedProfiles = await identityFetcher.getOverviewsByIds(
      distinct(
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
            ? relatedProfiles[it.cic_user]?.handle ?? it.cic_user
            : null
        },
        rep: {
          min: it.rep_min,
          max: it.rep_max,
          direction: it.rep_direction
            ? enums.resolve(ApiGroupFilterDirection, it.rep_direction)!
            : null,
          user_identity: it.rep_user
            ? relatedProfiles[it.rep_user]?.handle ?? it.rep_user
            : null,
          category: it.rep_category
        },
        level: {
          min: it.level_min,
          max: it.level_max
        },
        tdh: {
          min: it.tdh_min,
          max: it.tdh_max
        },
        owns_nfts: [
          it.owns_meme
            ? {
                name: ApiGroupOwnsNftNameEnum.Memes,
                tokens: it.owns_meme_tokens
                  ? JSON.parse(it.owns_meme_tokens)
                  : []
              }
            : null,
          it.owns_gradient
            ? {
                name: ApiGroupOwnsNftNameEnum.Gradients,
                tokens: it.owns_gradient_tokens
                  ? JSON.parse(it.owns_gradient_tokens)
                  : []
              }
            : null,
          it.owns_nextgen
            ? {
                name: ApiGroupOwnsNftNameEnum.Nextgen,
                tokens: it.owns_nextgen_tokens
                  ? JSON.parse(it.owns_nextgen_tokens)
                  : []
              }
            : null,
          it.owns_lab
            ? {
                name: ApiGroupOwnsNftNameEnum.Memelab,
                tokens: it.owns_lab_tokens ? JSON.parse(it.owns_lab_tokens) : []
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
            ?.excluded_identity_count ?? 0
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
}

export const userGroupsService = new UserGroupsService(
  userGroupsDb,
  abusivenessCheckService
);
