import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import {
  isTargetOfTypeDrop,
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { uniqueShortId } from '../helpers';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '../constants';
import { PageRequest } from '../api-serverless/src/page-request';
import { RateMatter } from '../entities/IRating';
import {
  CommunityMemberCriteriaService,
  communityMemberCriteriaService
} from '../api-serverless/src/community-members/community-member-criteria.service';

export class ProfileActivityLogsDb extends LazyDbAccessCompatibleService {
  constructor(
    dbSupplier: () => SqlExecutor,
    private readonly communitySearchSqlGenerator: CommunityMemberCriteriaService
  ) {
    super(dbSupplier);
  }

  public async insertMany(
    logs: NewProfileActivityLog[],
    connectionHolder?: ConnectionWrapper<any>
  ) {
    if (!connectionHolder) {
      await this.db.executeNativeQueriesInTransaction(
        async (connectionHolder) => {
          await this.insertManyInConnection(logs, connectionHolder);
        }
      );
    } else {
      await this.insertManyInConnection(logs, connectionHolder);
    }
  }

  private async insertManyInConnection(
    logs: NewProfileActivityLog[],
    connectionHolder: ConnectionWrapper<any>
  ) {
    for (const log of logs) {
      await this.insert(log, connectionHolder);
    }
  }

  public async insert(
    log: Omit<ProfileActivityLog, 'id' | 'created_at'>,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
    insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, created_at)
    values (:id, :profile_id, :target_id, :contents, :type, now())
    `,
      {
        ...log,
        id: uniqueShortId()
      },
      { wrappedConnection: connectionHolder }
    );
  }

  public async searchLogs(
    params: ProfileLogSearchParams
  ): Promise<ProfileActivityLog[]> {
    const viewResult =
      await this.communitySearchSqlGenerator.getSqlAndParamsByCriteriaId(
        params.curation_criteria_id
      );
    if (viewResult === null) {
      return [];
    }
    const page = params.pageRequest.page;
    const page_size =
      params.pageRequest.page_size < 1 || params.pageRequest.page_size > 2000
        ? 2000
        : params.pageRequest.page_size;
    let sql = `${viewResult.sql} select pa_logs.* from ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs join ${CommunityMemberCriteriaService.GENERATED_VIEW} crit_view on crit_view.profile_id = pa_logs.profile_id where 1=1`;
    const sqlParams: Record<string, any> = {
      ...viewResult.params,
      offset: (page - 1) * page_size,
      limit: page_size
    };
    if (params.profile_id) {
      if (params.includeProfileIdToIncoming) {
        sql += ` and (pa_logs.profile_id = :profile_id or pa_logs.target_id = :profile_id)`;
      } else {
        sql += ` and pa_logs.profile_id = :profile_id`;
      }
      sqlParams.profile_id = params.profile_id;
    }
    if (params.rating_matter) {
      sql += ` and JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_matter')) = :rating_matter`;
      sqlParams.rating_matter = params.rating_matter;
    }
    if (params.category) {
      sql += ` and JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_category')) = :rating_category`;
      sqlParams.rating_category = params.category;
    }
    if (params.target_id) {
      sql += ` and pa_logs.target_id = :target_id`;
      sqlParams.target_id = params.target_id;
    }
    if (params.type?.length) {
      sql += ` and pa_logs.type in (:type)`;
      sqlParams.type = params.type;
    }
    sql += ` order by pa_logs.created_at ${
      params.order.toLowerCase() === 'asc' ? 'asc' : 'desc'
    } limit :limit offset :offset`;
    return await this.db.execute(sql, sqlParams).then((rows) =>
      rows.map((r: ProfileActivityLog) => ({
        ...r,
        created_at: new Date(r.created_at)
      }))
    );
  }

  public async countLogs(params: ProfileLogSearchParams): Promise<number> {
    const viewResult =
      await this.communitySearchSqlGenerator.getSqlAndParamsByCriteriaId(
        params.curation_criteria_id
      );
    if (viewResult === null) {
      return 0;
    }
    let sql = `${viewResult.sql} select count(*) as cnt from ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs join ${CommunityMemberCriteriaService.GENERATED_VIEW} crit_view on crit_view.profile_id = pa_logs.profile_id where 1=1`;
    const sqlParams: Record<string, any> = {
      ...viewResult.params
    };
    if (params.profile_id) {
      if (params.includeProfileIdToIncoming) {
        sql += ` and (pa_logs.profile_id = :profile_id or pa_logs.target_id = :profile_id)`;
      } else {
        sql += ` and pa_logs.profile_id = :profile_id`;
      }
      sqlParams.profile_id = params.profile_id;
    }
    if (params.rating_matter) {
      sql += ` and JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_matter')) = :rating_matter`;
      sqlParams.rating_matter = params.rating_matter;
    }
    if (params.category) {
      sql += ` and JSON_UNQUOTE(JSON_EXTRACT(pa_logs.contents, '$.rating_category')) = :rating_category`;
      sqlParams.rating_category = params.category;
    }
    if (params.target_id) {
      sql += ` and pa_logs.target_id = :target_id`;
      sqlParams.target_id = params.target_id;
    }
    if (params.type?.length) {
      sql += ` and pa_logs.type in (:type)`;
      sqlParams.type = params.type;
    }
    return await this.db
      .execute(sql, sqlParams)
      .then((rows) => rows[0].cnt as number);
  }

  async changeSourceProfileIdInLogs(
    param: {
      newSourceId: string;
      oldSourceId: string;
    },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      update ${PROFILES_ACTIVITY_LOGS_TABLE} set profile_id = :newSourceId where profile_id = :oldSourceId
      `,
      param,
      { wrappedConnection: connectionHolder.connection }
    );
  }

  async changeTargetProfileIdInLogs(
    param: {
      newSourceId: string;
      oldSourceId: string;
    },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      update ${PROFILES_ACTIVITY_LOGS_TABLE} set target_id = :newSourceId where target_id = :oldSourceId and type in (:types)
      `,
      {
        ...param,
        types: Object.values(ProfileActivityLogType).filter(
          (t) => !isTargetOfTypeDrop(t)
        )
      },
      { wrappedConnection: connectionHolder.connection }
    );
  }
}

export type NewProfileActivityLog = Omit<
  ProfileActivityLog,
  'id' | 'created_at'
>;

export interface ProfileLogSearchParams {
  readonly curation_criteria_id: string | null;
  profile_id?: string;
  target_id?: string;
  rating_matter?: RateMatter;
  type?: ProfileActivityLogType[];
  pageRequest: PageRequest;
  includeProfileIdToIncoming: boolean;
  category?: string;
  order: 'asc' | 'desc';
}

export const profileActivityLogsDb = new ProfileActivityLogsDb(
  dbSupplier,
  communityMemberCriteriaService
);
