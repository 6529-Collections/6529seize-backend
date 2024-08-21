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
  UserGroupsService,
  userGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Timer } from '../time';

export class ProfileActivityLogsDb extends LazyDbAccessCompatibleService {
  constructor(
    dbSupplier: () => SqlExecutor,
    private readonly userGroupsService: UserGroupsService
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
    connectionHolder: ConnectionWrapper<any>,
    timer?: Timer
  ) {
    timer?.start('ProfileActivityLogsDb->insert');
    await this.db.execute(
      `
    insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, proxy_id, created_at)
    values (:id, :profile_id, :target_id, :contents, :type, :proxy_id, now())
    `,
      {
        ...log,
        id: uniqueShortId()
      },
      { wrappedConnection: connectionHolder }
    );
    timer?.stop('ProfileActivityLogsDb->insert');
  }

  public async searchLogs(
    params: ProfileLogSearchParams
  ): Promise<ProfileActivityLog[]> {
    let sql: string;
    const page = params.pageRequest.page;
    const page_size =
      params.pageRequest.page_size < 1 || params.pageRequest.page_size > 2000
        ? 2001
        : params.pageRequest.page_size;
    let sqlParams: Record<string, any> = {
      offset: (page - 1) * page_size,
      limit: page_size + 1
    };
    if (params.group_id) {
      const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
        params.group_id
      );
      if (viewResult === null) {
        return [];
      }
      sql = `${viewResult.sql} select pa_logs.* from ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs join ${UserGroupsService.GENERATED_VIEW} group_view on group_view.profile_id = pa_logs.profile_id where 1=1`;
      sqlParams = { ...sqlParams, ...viewResult.params };
    } else {
      sql = `select * from ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs where 1=1 `;
    }
    if (params.profile_id) {
      if (params.includeProfileIdToIncoming) {
        sql += ` and (pa_logs.profile_id = :profile_id or pa_logs.proxy_id = :profile_id or pa_logs.target_id = :profile_id)`;
      } else {
        sql += ` and (pa_logs.profile_id = :profile_id or pa_logs.proxy_id = :profile_id)`;
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
  readonly group_id: string | null;
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
  userGroupsService
);
