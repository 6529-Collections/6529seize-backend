import {
  CommunitySearchCriteria,
  FilterDirection
} from './community-search-criteria.types';
import { ALL_COMMUNITY_MEMBERS_VIEW, RATINGS_TABLE } from '../constants';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { getLevelComponentsBorderByLevel } from '../profiles/profile-level';

export class CommunitySearchSqlGenerator {
  public static GENERATED_VIEW = 'community_search_view';

  constructor(private readonly profilesService: ProfilesService) {}

  public async getSqlAndParams(criteria: CommunitySearchCriteria): Promise<{
    sql: string;
    params: Record<string, any>;
  } | null> {
    const filterUsers = [criteria.cic.user, criteria.rep.user].filter(
      (user) => !!user
    ) as string[];
    const userIds = await Promise.all(
      filterUsers.map((user) =>
        this.profilesService
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
      let groupedRepQuery = '';
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
    let cmPart = ` ${repPart || cicPart ? ',' : ''}
    ${
      CommunitySearchSqlGenerator.GENERATED_VIEW
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
    const sql = `with ${repPart ?? ''}${cicPart ?? ''}${cmPart}`;

    return {
      sql,
      params
    };
  }
}

export const communitySearchSqlGenerator: CommunitySearchSqlGenerator =
  new CommunitySearchSqlGenerator(profilesService);
