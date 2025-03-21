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
import {
  PROFILE_LATEST_LOG_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '../constants';
import { PageRequest } from '../api-serverless/src/page-request';
import { RateMatter } from '../entities/IRating';
import {
  UserGroupsService,
  userGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';

const mysql = require('mysql');

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
    const currentTime = Time.now().toDate();
    await this.bulkInsertProfileActivityLogs(
      logs.map((it) => ({
        ...it,
        created_at: currentTime,
        id: uniqueShortId()
      })),
      {
        connection: connectionHolder
      }
    );
  }

  public async insert(
    log: Omit<ProfileActivityLog, 'id' | 'created_at'>,
    connectionHolder: ConnectionWrapper<any>,
    timer?: Timer
  ) {
    timer?.start('ProfileActivityLogsDb->insert');
    const currentTime = Time.now().toDate();
    await Promise.all([
      this.db.execute(
        `
    insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, proxy_id, created_at, additional_data_1, additional_data_2)
    values (:id, :profile_id, :target_id, :contents, :type, :proxy_id, :currentTime, :additional_data_1, :additional_data_2)
    `,
        {
          ...log,
          currentTime,
          id: uniqueShortId()
        },
        { wrappedConnection: connectionHolder }
      ),
      this.db.execute(
        `insert into ${PROFILE_LATEST_LOG_TABLE} (profile_id, latest_activity) values (:profileId, :currentTime) on duplicate key update latest_activity = :currentTime`,
        { profileId: log.profile_id, currentTime },
        { wrappedConnection: connectionHolder }
      )
    ]);
    timer?.stop('ProfileActivityLogsDb->insert');
  }

  public async searchLogs(
    params: ProfileLogSearchParams,
    ctx: RequestContext
  ): Promise<ProfileActivityLog[]> {
    ctx.timer?.start(`${this.constructor.name}->searchLogs`);
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
        params.group_id,
        ctx
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
      sql += ` and additional_data_1 = :rating_matter`;
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
    const result = await this.db
      .execute<Omit<ProfileActivityLog, 'created_at'> & { created_at: string }>(
        sql,
        sqlParams
      )
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          created_at: new Date(r.created_at)
        }))
      );
    ctx.timer?.stop(`${this.constructor.name}->searchLogs`);
    return result;
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
      { wrappedConnection: connectionHolder }
    );
    try {
      await this.db.execute(
        `
      update ${PROFILE_LATEST_LOG_TABLE} set profile_id = :newSourceId where profile_id = :oldSourceId
      `,
        param,
        { wrappedConnection: connectionHolder }
      );
    } catch (e) {
      const dbError = e as { code?: string };
      if (dbError.code === 'ER_DUP_ENTRY') {
        await this.db.execute(
          `delete from ${PROFILE_LATEST_LOG_TABLE} where profile_id = :oldSourceId`,
          param,
          { wrappedConnection: connectionHolder }
        );
        await this.db.execute(
          `update ${PROFILE_LATEST_LOG_TABLE} set latest_activity = NOW() where profile_id = :newSourceId`,
          param,
          { wrappedConnection: connectionHolder }
        );
      } else {
        throw e;
      }
    }
    await this.db.execute(
      `
      update ${PROFILES_ACTIVITY_LOGS_TABLE} set additional_data_1 = :newSourceId where type in ('${ProfileActivityLogType.DROP_CLAPPED}', '${ProfileActivityLogType.DROP_VOTE_EDIT}') and additional_data_1 = :oldSourceId
      `,
      param,
      { wrappedConnection: connectionHolder }
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
      { wrappedConnection: connectionHolder }
    );
  }

  async bulkInsertProfileActivityLogs(
    logs: ProfileActivityLog[],
    ctx: RequestContext
  ) {
    if (!logs.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->bulkInsertProfileCreationLogs`);
    const sql = `
        insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (
           id, 
           profile_id, 
           target_id, 
           contents, 
           type,
           proxy_id, 
           created_at,
           additional_data_1,
           additional_data_2
        ) values ${logs
          .map(
            (log) =>
              `(${[
                log.id,
                log.profile_id,
                log.target_id,
                log.contents,
                log.type,
                log.proxy_id,
                log.created_at,
                log.additional_data_1,
                log.additional_data_2
              ]
                .map((it) => mysql.escape(it))
                .join(', ')})`
          )
          .join(', ')}
    `;
    await this.db.execute(sql, undefined, {
      wrappedConnection: ctx.connection
    });
    const profileIds = logs.reduce((acc, log) => {
      acc.add(log.profile_id);
      return acc;
    }, new Set<string>());
    const currentTime = Time.now().toDate();
    const latestLogsSql = `
        insert into ${PROFILE_LATEST_LOG_TABLE} (profile_id, latest_activity) values ${Array.from(
      profileIds
    )
      .map(
        (profileId) =>
          `(${[profileId, currentTime]
            .map((it) => mysql.escape(it))
            .join(', ')})`
      )
      .join(
        ', '
      )} ON DUPLICATE KEY UPDATE latest_activity = VALUES(latest_activity)
    `;
    await this.db.execute(latestLogsSql, undefined, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->bulkInsertProfileCreationLogs`);
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
