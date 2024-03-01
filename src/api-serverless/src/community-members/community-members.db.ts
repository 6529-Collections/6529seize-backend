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
  PROFILE_FULL,
  PROFILES_ACTIVITY_LOGS_TABLE,
  TRANSACTIONS_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../../../constants';

export interface CommunityMemberFromDb
  extends Omit<CommunityMemberOverview, 'level' | 'last_activity'> {
  readonly consolidation_key: string;
}

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
            p.rep_score as rep,
            p.pfp_url as pfp,
            p.consolidation_key as consolidation_key
        from ${PROFILE_FULL} p
        union all
        select
            t.consolidation_display as display,
            t.wallets->>'$[0]' as detail_view_key,
            t.boosted_tdh as level_components,
            t.boosted_tdh as tdh,
            0 as cic,
            0 as rep,
            null as pfp,
            t.consolidation_key as consolidation_key
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
          rep,
          pfp,
          consolidation_key
      from cm order by ${sort} ${query.sort_direction} limit ${query.page_size} offset ${offset}
    `);
  }

  async getCommunityMembersLastActivitiesByConsolidationKeys(
    consolidationKeys: string[]
  ): Promise<Record<string, number>> {
    const chunkSize = 20;
    const promises: Promise<
      { consolidation_key: string; last_activity: string }[]
    >[] = [];
    for (let i = 0; i < consolidationKeys.length; i += chunkSize) {
      const chunk = consolidationKeys.slice(i, i + chunkSize);
      if (chunk.length) {
        promises.push(
          this.db.execute(
            `
        with trx_max_dates as (select w.consolidation_key as consolidation_key, max(t.transaction_date) as last_activity
                               from ${WALLETS_CONSOLIDATION_KEYS_VIEW} w
                                        join ${TRANSACTIONS_TABLE} t
                                             on w.wallet is not null and t.from_address = w.wallet or t.to_address = w.wallet
                               where w.consolidation_key in (:consolidationKeys)
                               group by 1),
             prof_max_dates as (select p.consolidation_key as consolidation_key, max(l.created_at) as last_activity
                                from ${PROFILE_FULL} p
                                         join ${PROFILES_ACTIVITY_LOGS_TABLE} l
                                              on l.profile_id = p.external_id or l.target_id = p.external_id
                                where p.consolidation_key in (:consolidationKeys)
                                group by 1),
             last_activities_by_consolidation_key as (select t.consolidation_key,
                                                             t.last_activity
                                                      from trx_max_dates t
                                                      union all
                                                      select p.consolidation_key,
                                                             p.last_activity
                                                      from prof_max_dates p)
        select l.consolidation_key, max(l.last_activity) as last_activity
        from last_activities_by_consolidation_key l
        group by 1
      `,
            { consolidationKeys: chunk }
          )
        );
      }
    }
    const dbResults = (await Promise.all(promises)).flat();
    return dbResults.reduce((acc, row) => {
      acc[row.consolidation_key] = new Date(row.last_activity).getTime();
      return acc;
    }, {} as Record<string, number>);
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
