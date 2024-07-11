import {
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE
} from '../../../constants';
import { profilesService } from '../../../profiles/profiles.service';
import { getLevelComponentsBorderByLevel } from '../../../profiles/profile-level';
import { UserGroupEntity } from '../../../entities/IUserGroup';
import {
  userGroupsDb,
  UserGroupsDb
} from '../../../user-groups/user-groups.db';
import slugify from 'slugify';
import { distinct, resolveEnum, uniqueShortId } from '../../../helpers';
import { ConnectionWrapper } from '../../../sql-executor';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import {
  abusivenessCheckService,
  AbusivenessCheckService
} from '../../../profiles/abusiveness-check.service';
import { RateMatter } from '../../../entities/IRating';
import { ChangeGroupVisibility } from '../generated/models/ChangeGroupVisibility';
import { GroupFull } from '../generated/models/GroupFull';
import { GroupFilterDirection } from '../generated/models/GroupFilterDirection';
import { GroupDescription } from '../generated/models/GroupDescription';
import {
  GroupOwnsNft,
  GroupOwnsNftNameEnum
} from '../generated/models/GroupOwnsNft';
import { profilesApiService } from '../profiles/profiles.api.service';

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
    createdBy: { id: string; handle: string }
  ): Promise<GroupFull> {
    const savedEntity =
      await this.userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
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
              created_by: createdBy.id,
              visible: false,
              name: group.name,
              profile_group_id: inclusionGroups?.profile_group_id ?? null,
              excluded_profile_group_id:
                exclusionGroups?.profile_group_id ?? null
            },
            connection
          );
          return await this.getByIdOrThrow(id, connection);
        }
      );
    await giveReadReplicaTimeToCatchUp();
    return savedEntity;
  }

  public async getGroupsUserIsEligibleFor(
    profileId: string | null
  ): Promise<string[]> {
    if (!profileId) {
      return [];
    }
    const profile = await this.userGroupsDb.getProfileOverviewByProfileId(
      profileId
    );
    if (profile === null) {
      return [];
    }
    const [groupsUserIsEligibleByIdentity, groupsUserIsBannedFromByIdentity] =
      await Promise.all([
        this.userGroupsDb.getGroupsUserIsEligibleByIdentity(profileId),
        this.userGroupsDb.getGroupsUserIsExcludedFromByIdentity(profileId)
      ]);
    const givenCicAndRep = await this.userGroupsDb.getGivenCicAndRep(profileId);
    const initialSelection =
      await this.userGroupsDb.getGroupsMatchingConditions({
        profileId,
        receivedCic: profile.cic,
        receivedRep: profile.rep,
        tdh: profile.tdh,
        level: profile.level,
        givenCic: givenCicAndRep.cic,
        givenRep: givenCicAndRep.rep
      });
    const ambiguousCandidates = initialSelection.filter(
      (group) => group.cic_user ?? group.rep_user ?? group.rep_category
    );
    if (!ambiguousCandidates.length) {
      return initialSelection.map((it) => it.id);
    }
    const cicUsers = ambiguousCandidates
      .map((group) => group.cic_user)
      .filter((it) => !!it && it !== profileId) as string[];
    const repUsers = ambiguousCandidates
      .map((group) => group.rep_user)
      .filter((it) => !!it && it !== profileId) as string[];
    const repCategories = ambiguousCandidates
      .map((group) => group.rep_category)
      .filter((it) => !!it) as string[];
    const unambiguousInitial = initialSelection.filter(
      (group) => !group.cic_user && !group.rep_user && !group.rep_category
    );
    const ratings = await this.userGroupsDb.getRatings(
      profileId,
      distinct([...cicUsers, ...repUsers]),
      repCategories
    );
    const ambiguousCleaned = ambiguousCandidates.filter((group) => {
      if (group.cic_user) {
        const userRating = ratings
          .filter(
            (rating) =>
              rating.matter === RateMatter.CIC &&
              (GroupFilterDirection.Received
                ? rating.rater_profile_id
                : rating.matter_target_id) === group.cic_user
          )
          .map((it) => it.rating)
          .reduce((acc, it) => acc + it, 0);
        if (
          userRating < (group.cic_min ?? 0) ||
          userRating > (group.cic_max ?? Number.MAX_SAFE_INTEGER)
        ) {
          return false;
        }
      }
      if (group.rep_user && !group.rep_category) {
        const userRating = ratings
          .filter(
            (rating) =>
              rating.matter === RateMatter.REP &&
              (GroupFilterDirection.Received
                ? rating.rater_profile_id
                : rating.matter_target_id) === group.rep_user
          )
          .map((it) => it.rating)
          .reduce((acc, it) => acc + it, 0);
        if (
          userRating < (group.rep_min ?? 0) ||
          userRating > (group.rep_max ?? Number.MAX_SAFE_INTEGER)
        ) {
          return false;
        }
      }
      if (group.rep_user && group.rep_category) {
        const userRating = ratings
          .filter(
            (rating) =>
              rating.matter === RateMatter.REP &&
              (GroupFilterDirection.Received
                ? rating.rater_profile_id
                : rating.matter_target_id) === group.rep_user &&
              rating.matter_category === group.rep_category
          )
          .map((it) => it.rating)
          .reduce((acc, it) => acc + it, 0);
        if (
          userRating < (group.rep_min ?? 0) ||
          userRating > (group.rep_max ?? Number.MAX_SAFE_INTEGER)
        ) {
          return false;
        }
      }
      if (!group.rep_user && group.rep_category) {
        const userRating = ratings
          .filter(
            (rating) =>
              rating.matter === RateMatter.REP &&
              (GroupFilterDirection.Received
                ? rating.rater_profile_id
                : rating.matter_target_id) === profileId &&
              rating.matter_category === group.rep_category
          )
          .map((it) => it.rating)
          .reduce((acc, it) => acc + it, 0);
        if (
          userRating < (group.rep_min ?? 0) ||
          userRating > (group.rep_max ?? Number.MAX_SAFE_INTEGER)
        ) {
          return false;
        }
      }
    });
    const allThatIsLeft = [...ambiguousCleaned, ...unambiguousInitial];
    const onlyProfileGroupsFilteredOut = allThatIsLeft.filter((group) => {
      return !(
        group.level_max === null ||
        group.level_min === null ||
        group.tdh_max === null ||
        group.tdh_min === null ||
        group.rep_max === null ||
        group.rep_min === null ||
        group.rep_user === null ||
        group.rep_category === null ||
        group.cic_max === null ||
        group.cic_min === null ||
        group.cic_user === null
      );
    });
    return distinct(
      [
        ...onlyProfileGroupsFilteredOut.map((it) => it.id),
        ...groupsUserIsEligibleByIdentity
      ].filter((it) => !groupsUserIsBannedFromByIdentity.includes(it) && !!it)
    );
  }

  async changeVisibility({
    group_id,
    old_version_id,
    visible,
    profile_id
  }: ChangeGroupVisibility & {
    group_id: string;
    profile_id: string;
  }): Promise<GroupFull> {
    const updatedGroupEntity =
      await this.userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const groupEntity = await this.getByIdOrThrow(group_id);
          if (old_version_id) {
            if (old_version_id === groupEntity.id) {
              throw new BadRequestException(
                'Old version id should not be the same as the current'
              );
            }
            const oldGroupEntity = await this.getByIdOrThrow(old_version_id);
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
            connection
          );
        }
      );
    await giveReadReplicaTimeToCatchUp();
    return updatedGroupEntity;
  }

  private async doNameAbusivenessCheck(groupEntity: GroupFull) {
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
    connection?: ConnectionWrapper<any>
  ): Promise<GroupFull> {
    const group = await this.userGroupsDb.getById(id, connection);
    if (!group) {
      throw new NotFoundException(`Group with id ${id} not found`);
    }
    return (await this.mapForApi([group])).at(0)!;
  }

  public async getSqlAndParamsByGroupId(groupId: string | null): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    if (groupId === null) {
      return await this.getSqlAndParams({
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
      });
    } else {
      const group = await this.getByIdOrThrow(groupId);
      return await this.getSqlAndParams(group.group);
    }
  }

  private async getSqlAndParams(
    group: Omit<
      GroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >
  ): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    const filterUsers = [
      group.cic.user_identity,
      group.rep.user_identity
    ].filter((user) => !!user) as string[];
    const userIds = await Promise.all(
      filterUsers.map((user) =>
        profilesService
          .getProfileAndConsolidationsByIdentity(user)
          .then((result) => result?.profile?.external_id ?? null)
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
    const cmPart = this.getGeneralPart(repPart, cicPart, group, params);
    const inclusionExclusionPart = this.getInclusionExclusionPart(
      group,
      params
    );
    const sql = `with ${repPart ?? ''} ${
      cicPart ?? ''
    } ${cmPart} ${inclusionExclusionPart} `;
    return {
      sql,
      params
    };
  }

  private getInclusionExclusionPart(
    group: Omit<
      GroupDescription,
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

  private getGeneralPart(
    repPart: string | null,
    cicPart: string | null,
    group: Omit<
      GroupDescription,
      | 'identity_group_identities_count'
      | 'excluded_identity_group_identities_count'
    >,
    params: Record<string, any>
  ) {
    let cmPart = ` ${repPart || cicPart ? ', ' : ' '}`;
    cmPart += ` cm_view as (select i.* from ${IDENTITIES_TABLE} i `;
    if (repPart !== null) {
      cmPart += `join rep_exchanges on i.profile_id = rep_exchanges.profile_id `;
    }
    if (cicPart !== null) {
      cmPart += `join cic_exchanges on i.profile_id = cic_exchanges.profile_id `;
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
      GroupDescription,
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
        ? cicGroup.direction ?? GroupFilterDirection.Received
        : GroupFilterDirection.Received;
      if (cicGroup.user_identity) {
        params.cic_user = cicGroup.user_identity;
      }
      let groupedCicQuery;
      if (cicGroup.user_identity !== null) {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === GroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, rating from ${RATINGS_TABLE} where matter = 'CIC' and rating <> 0 and ${
          direction === GroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :cic_user)`;
        params.cic_user = cicGroup.user_identity;
      } else {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === GroupFilterDirection.Received
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
      GroupDescription,
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
      const direction = repGroup.direction ?? GroupFilterDirection.Received;
      if (repGroup.user_identity) {
        params.rep_user = repGroup.user_identity;
      }
      let groupedRepQuery: string;
      if (repGroup.user_identity !== null && repGroup.category !== null) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === GroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 and ${
          direction === GroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user)`;
      } else if (
        repGroup.user_identity !== null &&
        repGroup.category === null
      ) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === GroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 and ${
          direction === GroupFilterDirection.Received
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user group by 1, 2)`;
      } else if (
        repGroup.user_identity === null &&
        repGroup.category !== null
      ) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === GroupFilterDirection.Received
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and rating <> 0 group by 1, 2)`;
      } else {
        groupedRepQuery = `grouped_reps as (select ${
          direction === GroupFilterDirection.Received
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
    createdAtLessThan: number | null
  ): Promise<GroupFull[]> {
    const group = await this.userGroupsDb.searchByNameOrAuthor(
      name,
      authorId,
      createdAtLessThan
    );
    return await this.mapForApi(group);
  }

  async getByIds(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<UserGroupEntity[]> {
    return await this.userGroupsDb.getByIds(ids, connection);
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
    authenticatedUserId?: string
  ): Promise<GroupFull[]> {
    const relatedProfiles = await profilesApiService.getProfileMinsByIds({
      ids: distinct(
        groups
          .map(
            (it) =>
              [it.created_by, it.rep_user, it.cic_user].filter(
                (it) => !!it
              ) as string[]
          )
          .flat()
      ),
      authenticatedProfileId: authenticatedUserId
    });
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
        groups.map((it) => it.id)
      );
    return groups.map<GroupFull>((it) => ({
      id: it.id,
      name: it.name,
      visible: it.visible,
      created_at: new Date(it.created_at).getTime(),
      group: {
        cic: {
          min: it.cic_min,
          max: it.cic_max,
          direction: it.cic_direction
            ? resolveEnum(GroupFilterDirection, it.cic_direction)!
            : null,
          user_identity: it.cic_user
            ? relatedProfiles[it.cic_user]?.handle ?? it.cic_user
            : null
        },
        rep: {
          min: it.rep_min,
          max: it.rep_max,
          direction: it.rep_direction
            ? resolveEnum(GroupFilterDirection, it.rep_direction)!
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
                name: GroupOwnsNftNameEnum.Memes,
                tokens: it.owns_meme_tokens
                  ? JSON.parse(it.owns_meme_tokens)
                  : []
              }
            : null,
          it.owns_gradient
            ? {
                name: GroupOwnsNftNameEnum.Gradients,
                tokens: it.owns_gradient_tokens
                  ? JSON.parse(it.owns_gradient_tokens)
                  : []
              }
            : null,
          it.owns_nextgen
            ? {
                name: GroupOwnsNftNameEnum.Nextgen,
                tokens: it.owns_nextgen_tokens
                  ? JSON.parse(it.owns_nextgen_tokens)
                  : []
              }
            : null,
          it.owns_lab
            ? {
                name: GroupOwnsNftNameEnum.Memelab,
                tokens: it.owns_lab_tokens ? JSON.parse(it.owns_lab_tokens) : []
              }
            : null
        ].filter((it) => !!it) as GroupOwnsNft[],
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
  }
}

export const userGroupsService = new UserGroupsService(
  userGroupsDb,
  abusivenessCheckService
);
