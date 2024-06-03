import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import {
  CommunityMemberOverview,
  CommunityMembersQuery
} from './community-members.types';
import {
  PROFILE_FULL,
  PROFILES_ACTIVITY_LOGS_TABLE,
  TRANSACTIONS_TABLE,
  WALLETS_CONSOLIDATION_KEYS_VIEW
} from '../../../constants';
import { UserGroupsService, userGroupsService } from './user-groups.service';

export interface CommunityMemberFromDb
  extends Omit<CommunityMemberOverview, 'last_activity'> {
  readonly consolidation_key: string;
}

export class CommunityMembersDb extends LazyDbAccessCompatibleService {
  constructor(
    dbSupplier: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
  ) {
    super(dbSupplier);
  }

  async getCommunityMembers(
    query: CommunityMembersQuery
  ): Promise<CommunityMemberFromDb[]> {
    const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
      query.group_id
    );
    if (viewResult === null) {
      return [];
    }
    const offset = query.page_size * (query.page - 1);
    return this.db.execute(
      `
      ${viewResult.sql} 
      select
        cm.display as display,
        ifnull(cm.handle, cm.wallet1) as detail_view_key,
        cm.level as level,
        cm.tdh as tdh,
        cm.cic as cic,
        cm.rep as rep,
        cm.pfp as pfp,
        cm.consolidation_key as consolidation_key
      from ${UserGroupsService.GENERATED_VIEW} cm order by cm.${query.sort} ${query.sort_direction} limit ${query.page_size} offset ${offset}
    `,
      viewResult.params
    );
  }

  async countCommunityMembers(query: CommunityMembersQuery): Promise<number> {
    const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
      query.group_id
    );
    if (viewResult === null) {
      return 0;
    }
    return this.db
      .execute(
        `
      ${viewResult.sql} 
      select count(*) as cnt from ${UserGroupsService.GENERATED_VIEW} cm
    `,
        viewResult.params
      )
      .then((rows) => rows[0].cnt as number);
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
                                              on l.profile_id = p.external_id
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
}

export const communityMembersDb = new CommunityMembersDb(
  dbSupplier,
  userGroupsService
);
