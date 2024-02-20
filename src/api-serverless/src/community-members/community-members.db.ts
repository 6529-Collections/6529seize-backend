import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import {
  CommunityMemberOverview,
  CommunityMembersQuery,
  CommunityMembersSortOption
} from './community-members.types';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  PROFILE_FULL
} from '../../../constants';

export type CommunityMemberFromDb = Omit<CommunityMemberOverview, 'level'>;

export class CommunityMembersDb extends LazyDbAccessCompatibleService {
  async getCommunityMembers(
    query: CommunityMembersQuery
  ): Promise<CommunityMemberFromDb[]> {
    const sort =
      query.sort === CommunityMembersSortOption.LEVEL
        ? 'level_components'
        : query.sort;
    const offset = query.page_size * (query.page - 1);
    return this.db.execute(`
      with cm as (
        select
            p.handle as display,
            p.handle as detail_view_key,
            p.rep_score + p.profile_tdh as level_components,
            p.profile_tdh as tdh,
            p.cic_score as cic,
            p.rep_score as rep
        from ${PROFILE_FULL} p
        union all
        select
            t.consolidation_display as display,
            t.wallets->>'$[0]' as detail_view_key,
            t.boosted_tdh as level_components,
            t.boosted_tdh as tdh,
            0 as cic,
            0 as rep
        from ${CONSOLIDATED_WALLETS_TDH_TABLE} as t
            left join  ${PROFILE_FULL} as p on t.consolidation_key = p.consolidation_key
        where p.consolidation_key is null
      )
      select
          display,
          detail_view_key,
          level_components,
          tdh,
          cic,
          rep
      from cm order by ${sort} ${query.sort_direction} limit ${query.page_size} offset ${offset}
    `);
  }

  async countCommunityMembers(): Promise<number> {
    return this.db
      .execute(
        `
      with cm as (
        select
            p.handle as display,
            p.handle as detail_view_key,
            p.rep_score + p.profile_tdh as level_components,
            p.cic_score as cic_score,
            p.rep_score as rep_score
        from ${PROFILE_FULL} p
        union all
        select
            t.consolidation_display as display,
            t.wallets->>'$[0]'detail_view_key,
            t.boosted_tdh as level,
            0 as cic_score,
            0 as rep_score
        from ${CONSOLIDATED_WALLETS_TDH_TABLE} as t
            left join  ${PROFILE_FULL} as p on t.consolidation_key = p.consolidation_key
        where p.consolidation_key is null
      )
      select count(*) as cnt from cm
    `
      )
      .then((result) => result[0].cnt as number);
  }
}

export const communityMembersDb = new CommunityMembersDb(dbSupplier);
