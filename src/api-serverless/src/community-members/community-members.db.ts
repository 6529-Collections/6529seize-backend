import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILE_LATEST_LOG_TABLE,
  TRANSACTIONS_TABLE
} from '../../../constants';
import { RequestContext } from '../../../request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../../../sql-executor';
import { ApiCommunityMemberOverview } from '../generated/models/ApiCommunityMemberOverview';
import { CommunityMembersQuery } from './community-members.types';
import { UserGroupsService, userGroupsService } from './user-groups.service';

export interface CommunityMemberFromDb
  extends Omit<ApiCommunityMemberOverview, 'last_activity'> {
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
    query: CommunityMembersQuery,
    ctx: RequestContext
  ): Promise<CommunityMemberFromDb[]> {
    const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
      query.group_id,
      ctx
    );
    if (viewResult === null) {
      return [];
    }
    const offset = query.page_size * (query.page - 1);
    let sort: string = query.sort;
    if (sort === 'level') {
      sort = 'level_raw';
    } else if (sort === 'combined_tdh') {
      sort = '(cm.tdh + cm.xtdh)';
    } else if (sort === 'tdh_rate') {
      sort = 'basetdh_rate';
    }
    const orderByClause = sort === '(cm.tdh + cm.xtdh)' ? sort : `cm.${sort}`;
    const sql = `
      ${viewResult.sql} 
      select
        ifnull(cm.handle, cm.primary_address) as display,
        ifnull(cm.handle, cm.primary_address) as detail_view_key,
        cm.level_raw as level,
        cm.tdh as tdh,
        cm.basetdh_rate as tdh_rate,
        cm.primary_address as wallet,
        cm.xtdh as xtdh,
        cm.xtdh_rate as xtdh_rate,
        (cm.tdh + cm.xtdh) as combined_tdh,
        cm.cic as cic,
        cm.rep as rep,
        cm.pfp as pfp,
        cm.consolidation_key as consolidation_key
      from ${UserGroupsService.GENERATED_VIEW} cm order by ${orderByClause} ${query.sort_direction} limit ${query.page_size} offset ${offset}
    `;
    const params = viewResult.params;
    ctx.timer?.start(`${this.constructor.name}->getCommunityMembers`);
    const result = await this.db.execute<CommunityMemberFromDb>(sql, params);
    ctx?.timer?.stop(`${this.constructor.name}->getCommunityMembers`);
    return result;
  }

  async countCommunityMembers(
    query: CommunityMembersQuery,
    ctx: RequestContext
  ): Promise<number> {
    const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
      query.group_id,
      ctx
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
    consolidationKeys: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    const chunkSize = 20;
    const promises: Promise<
      { consolidation_key: string; last_activity: string }[]
    >[] = [];
    ctx.timer?.start(
      `${this.constructor.name}->getCommunityMembersLastActivitiesByConsolidationKeys`
    );
    for (let i = 0; i < consolidationKeys.length; i += chunkSize) {
      const chunk = consolidationKeys.slice(i, i + chunkSize);
      if (chunk.length) {
        const params = { consolidationKeys: chunk };
        const sql = `
            with trx_max_dates as (select a.consolidation_key as consolidation_key, max(t.transaction_date) as last_activity
                                   from ${ADDRESS_CONSOLIDATION_KEY} a
                                            join ${TRANSACTIONS_TABLE} t
                                                 on a.address is not null and t.from_address = a.address or t.to_address = a.address
                                   where a.consolidation_key in (:consolidationKeys)
                                   group by 1),
                 prof_max_dates as (select i.consolidation_key as consolidation_key, l.latest_activity as last_activity
                                    from ${IDENTITIES_TABLE} i
                                             join ${PROFILE_LATEST_LOG_TABLE} l
                                                  on l.profile_id = i.profile_id
                                    where i.consolidation_key in (:consolidationKeys)),
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
        `;
        promises.push(this.db.execute(sql, params));
      }
    }
    const dbResults = (await Promise.all(promises)).flat();
    ctx.timer?.stop(
      `${this.constructor.name}->getCommunityMembersLastActivitiesByConsolidationKeys`
    );
    return dbResults.reduce(
      (acc, row) => {
        acc[row.consolidation_key] = new Date(row.last_activity).getTime();
        return acc;
      },
      {} as Record<string, number>
    );
  }
}

export const communityMembersDb = new CommunityMembersDb(
  dbSupplier,
  userGroupsService
);
