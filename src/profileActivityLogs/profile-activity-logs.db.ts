import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import { uniqueShortId } from '../helpers';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '../constants';
import { Page, PageRequest } from '../api-serverless/src/page-request';

export class ProfileActivityLogsDb extends LazyDbAccessCompatibleService {
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
      { wrappedConnection: connectionHolder.connection }
    );
  }

  public async searchLogs(
    params: ProfileLogSearchParams
  ): Promise<Page<ProfileActivityLog>> {
    const page = params.pageRequest.page;
    const page_size =
      params.pageRequest.page_size < 1 || params.pageRequest.page_size > 2000
        ? 2000
        : params.pageRequest.page_size;
    let sql = `select * from ${PROFILES_ACTIVITY_LOGS_TABLE} where 1=1`;
    let countSql = `select count(*) as cnt from ${PROFILES_ACTIVITY_LOGS_TABLE} where 1=1`;
    const sqlParams: Record<string, any> = {
      offset: (page - 1) * page_size,
      limit: page_size
    };
    const countParams: Record<string, any> = {};
    if (params.profile_id) {
      sql += ` and profile_id = :profile_id`;
      countSql += ` and profile_id = :profile_id`;
      sqlParams.profile_id = params.profile_id;
      countParams.profile_id = params.profile_id;
    }
    if (params.target_id) {
      sql += ` and target_id = :target_id`;
      countSql += ` and target_id = :target_id`;
      sqlParams.target_id = params.target_id;
      countParams.target_id = params.target_id;
    }
    if (params.type?.length) {
      sql += ` and type in (:type)`;
      countSql += ` and type in (:type)`;
      sqlParams.type = params.type;
      countParams.type = params.type;
    }
    sql += ` order by created_at ${
      params.order.toLowerCase() === 'asc' ? 'asc' : 'desc'
    } limit :limit offset :offset`;
    const [logs, count] = await Promise.all([
      this.db.execute(sql, sqlParams).then((rows) =>
        rows.map((r: ProfileActivityLog) => ({
          ...r,
          created_at: new Date(r.created_at)
        }))
      ),
      this.db.execute(countSql, countParams)
    ]);
    return {
      count: count[0]['cnt'],
      page,
      next: logs.length === page_size,
      data: logs
    };
  }
}

export type NewProfileActivityLog = Omit<
  ProfileActivityLog,
  'id' | 'created_at'
>;

export interface ProfileLogSearchParams {
  profile_id?: string;
  target_id?: string;
  type?: ProfileActivityLogType[];
  pageRequest: PageRequest;
  order: 'asc' | 'desc';
}

export const profileActivityLogsDb = new ProfileActivityLogsDb(dbSupplier);
