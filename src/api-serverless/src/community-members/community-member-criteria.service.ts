import {
  CommunityMembersCurationCriteria,
  FilterDirection
} from './community-search-criteria.types';
import { ALL_COMMUNITY_MEMBERS_VIEW, RATINGS_TABLE } from '../../../constants';
import { profilesService } from '../../../profiles/profiles.service';
import { getLevelComponentsBorderByLevel } from '../../../profiles/profile-level';
import { CommunityMembersCurationCriteriaEntity } from '../../../entities/ICommunityMembersCurationCriteriaEntity';
import {
  communityMemberCriteriaDb,
  CommunityMemberCriteriaDb
} from './community-member-criteria.db';
import slugify from 'slugify';
import { uniqueShortId } from '../../../helpers';
import { ConnectionWrapper } from '../../../sql-executor';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

export type NewCommunityMembersCurationCriteria = Omit<
  CommunityMembersCurationCriteriaEntity,
  'id' | 'created_at' | 'created_by'
>;

export interface ChangeCommunityMembersCurationCriteriaVisibility {
  criteria_id: string;
  visible: boolean;
  old_version_id: string | null;
  profile_id: string;
}

export class CommunityMemberCriteriaService {
  public static readonly GENERATED_VIEW = 'community_search_view';

  constructor(
    private readonly communityMemberCriteriaDb: CommunityMemberCriteriaDb
  ) {}

  async saveCurationCriteria(
    criteria: NewCommunityMembersCurationCriteria,
    createdBy: string
  ): Promise<CommunityMembersCurationCriteriaEntity> {
    const savedEntity =
      await this.communityMemberCriteriaDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const id =
            slugify(criteria.name, {
              replacement: '-',
              lower: true,
              strict: true
            }).slice(0, 50) +
            '-' +
            uniqueShortId();
          await this.communityMemberCriteriaDb.save(
            {
              ...criteria,
              id,
              created_at: new Date(),
              created_by: createdBy,
              visible: false
            },
            connection
          );
          return await this.getCriteriaByIdOrThrow(id, connection);
        }
      );
    await giveReadReplicaTimeToCatchUp();
    return savedEntity;
  }

  async changeCriteriaVisibility({
    criteria_id,
    old_version_id,
    visible,
    profile_id
  }: ChangeCommunityMembersCurationCriteriaVisibility): Promise<CommunityMembersCurationCriteriaEntity> {
    const updatedCriteriaEntity =
      await this.communityMemberCriteriaDb.executeNativeQueriesInTransaction(
        async (connection) => {
          const criteriaEntity = await this.getCriteriaByIdOrThrow(criteria_id);
          if (old_version_id) {
            if (old_version_id === criteriaEntity.id) {
              throw new BadRequestException(
                'Old version id should not be the same as the current'
              );
            }
            const oldCriteriaEntity = await this.getCriteriaByIdOrThrow(
              old_version_id
            );
            if (oldCriteriaEntity.created_by !== profile_id) {
              throw new BadRequestException(
                `You are not allowed to change criteria ${old_version_id}. You can save a new one instead.`
              );
            }
            await this.communityMemberCriteriaDb.changeCriteriaVisibility(
              old_version_id,
              false,
              connection
            );
          }
          if (criteriaEntity.created_by !== profile_id) {
            throw new BadRequestException(
              `You are not allowed to change criteria ${criteria_id}. You can save a new one instead.`
            );
          }
          await this.communityMemberCriteriaDb.changeCriteriaVisibility(
            criteria_id,
            visible,
            connection
          );
          return await this.getCriteriaByIdOrThrow(criteria_id, connection);
        }
      );
    await giveReadReplicaTimeToCatchUp();
    return updatedCriteriaEntity;
  }

  public async getCriteriaByIdOrThrow(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<CommunityMembersCurationCriteriaEntity> {
    const criteria = await this.communityMemberCriteriaDb.getById(
      id,
      connection
    );
    if (!criteria) {
      throw new NotFoundException(`Criteria with id ${id} not found`);
    }
    return criteria;
  }

  public async getSqlAndParamsByCriteriaId(criteriaId: string | null): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    if (criteriaId === null) {
      return await this.getSqlAndParams({
        cic: {
          min: null,
          max: null,
          user: null,
          direction: null
        },
        rep: {
          min: null,
          max: null,
          user: null,
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
        }
      });
    } else {
      const criteria = await this.getCriteriaByIdOrThrow(criteriaId);
      return await this.getSqlAndParams(criteria.criteria);
    }
  }

  private async getSqlAndParams(
    criteria: CommunityMembersCurationCriteria
  ): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    const filterUsers = [criteria.cic.user, criteria.rep.user].filter(
      (user) => !!user
    ) as string[];
    const userIds = await Promise.all(
      filterUsers.map((user) =>
        profilesService
          .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(user)
          .then((result) => result?.profile?.external_id ?? null)
      )
    );
    if (userIds.find((it) => it === null)) {
      return null;
    }
    const usersToUserIds = filterUsers.reduce((acc, user, index) => {
      acc[user] = userIds[index]!;
      return acc;
    }, {} as Record<string, string>);
    criteria.cic.user = criteria.cic.user
      ? usersToUserIds[criteria.cic.user]
      : null;
    criteria.rep.user = criteria.rep.user
      ? usersToUserIds[criteria.rep.user]
      : null;
    criteria.level.min = criteria.level.min
      ? getLevelComponentsBorderByLevel(criteria.level.min)
      : null;
    criteria.level.max = criteria.level.max
      ? getLevelComponentsBorderByLevel(criteria.level.max)
      : null;

    const params: Record<string, any> = {};
    const repPart = this.getRepPart(criteria, params);
    const cicPart = this.getCicPart(criteria, params, repPart);
    const cmPart = this.getGeneralPart(repPart, cicPart, criteria, params);
    const sql = `with ${repPart ?? ''}${cicPart ?? ''}${cmPart}`;

    return {
      sql,
      params
    };
  }

  private getGeneralPart(
    repPart: string | null,
    cicPart: string | null,
    criteria: CommunityMembersCurationCriteria,
    params: Record<string, any>
  ) {
    let cmPart = ` ${repPart || cicPart ? ',' : ''}
    ${
      CommunityMemberCriteriaService.GENERATED_VIEW
    } as (select a.* from ${ALL_COMMUNITY_MEMBERS_VIEW} a
    `;
    if (repPart !== null) {
      cmPart += `join rep_exchanges on a.profile_id = rep_exchanges.profile_id `;
    }
    if (cicPart !== null) {
      cmPart += `join cic_exchanges on a.profile_id = cic_exchanges.profile_id `;
    }
    cmPart += `where true `;
    if (criteria.tdh.min !== null) {
      cmPart += `and a.tdh >= :tdh_min `;
      params.tdh_min = criteria.tdh.min;
    }
    if (criteria.tdh.max !== null) {
      cmPart += `and a.tdh <= :tdh_max `;
      params.tdh_max = criteria.tdh.max;
    }
    if (criteria.level.min !== null) {
      cmPart += `and a.level >= :level_min `;
      params.level_min = criteria.level.min;
    }
    if (criteria.level.max !== null) {
      cmPart += `and a.level <= :level_max `;
      params.level_max = criteria.level.max;
    }
    cmPart += ') ';
    return cmPart;
  }

  private getCicPart(
    criteria: CommunityMembersCurationCriteria,
    params: Record<string, any>,
    repPart: string | null
  ) {
    const cicCriteria = criteria.cic;
    let cicPart = null;
    if (cicCriteria.user || cicCriteria.min || cicCriteria.max) {
      const direction = cicCriteria.user
        ? cicCriteria.direction ?? FilterDirection.RECEIVED
        : FilterDirection.RECEIVED;
      if (cicCriteria.user) {
        params.cic_user = cicCriteria.user;
      }
      let groupedCicQuery;
      if (cicCriteria.user !== null) {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, rating from ${RATINGS_TABLE} where matter = 'CIC' and ${
          direction === FilterDirection.RECEIVED
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :cic_user)`;
        params.cic_user = cicCriteria.user;
      } else {
        groupedCicQuery = `${repPart ? ', ' : ' '}grouped_cics as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC' group by 1)`;
      }
      cicPart = `${groupedCicQuery}, cic_exchanges as (select profile_id from grouped_cics where true `;
      if (cicCriteria.max !== null) {
        cicPart += `and rating <= :cic_amount_max `;
        params.cic_amount_max = cicCriteria.max;
      }
      if (cicCriteria.min !== null) {
        cicPart += `and rating >= :cic_amount_min `;
        params.cic_amount_min = cicCriteria.min;
      }
      cicPart += `) `;
    }
    return cicPart;
  }

  private getRepPart(
    criteria: CommunityMembersCurationCriteria,
    params: Record<string, any>
  ) {
    let repPart = null;
    const repCriteria = criteria.rep;
    if (
      repCriteria.category ||
      repCriteria.user ||
      repCriteria.max ||
      repCriteria.min
    ) {
      const direction = repCriteria.direction ?? FilterDirection.RECEIVED;
      if (repCriteria.user) {
        params.rep_user = repCriteria.user;
      }
      let groupedRepQuery: string;
      if (repCriteria.user !== null && repCriteria.category !== null) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, rating from ${RATINGS_TABLE} where matter = 'REP' and ${
          direction === FilterDirection.RECEIVED
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user)`;
      } else if (repCriteria.user !== null && repCriteria.category === null) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' and ${
          direction === FilterDirection.RECEIVED
            ? 'rater_profile_id'
            : 'matter_target_id'
        } = :rep_user group by 1, 2)`;
      } else if (repCriteria.user === null && repCriteria.category !== null) {
        groupedRepQuery = `grouped_reps as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' group by 1, 2)`;
      } else {
        groupedRepQuery = `grouped_reps as (select ${
          direction === FilterDirection.RECEIVED
            ? 'matter_target_id'
            : 'rater_profile_id'
        } as profile_id, null as matter_category, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' group by 1, 2)`;
      }

      repPart = `${groupedRepQuery}, rep_exchanges as (select profile_id from grouped_reps where true `;
      if (repCriteria.category !== null) {
        repPart += `and matter_category = :rep_category `;
        params.rep_category = repCriteria.category;
      }
      if (repCriteria.max !== null) {
        repPart += `and rating <= :rep_amount_max `;
        params.rep_amount_max = repCriteria.max;
      }
      if (repCriteria.min !== null) {
        repPart += `and rating >= :rep_amount_min `;
        params.rep_amount_min = repCriteria.min;
      }
      repPart += `) `;
    }
    return repPart;
  }

  async searchCriteria(
    curationCriteriaName: string | null,
    curationCriteriaUserId: string | null
  ): Promise<CommunityMembersCurationCriteriaEntity[]> {
    return await this.communityMemberCriteriaDb.searchCriteria(
      curationCriteriaName,
      curationCriteriaUserId
    );
  }
}

export const communityMemberCriteriaService =
  new CommunityMemberCriteriaService(communityMemberCriteriaDb);