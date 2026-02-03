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
import {
  PROFILE_LATEST_LOG_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { PageRequest } from '../api-serverless/src/page-request';
import { RateMatter } from '../entities/IRating';
import {
  UserGroupsService,
  userGroupsService
} from '../api-serverless/src/community-members/user-groups.service';
import { Time, Timer } from '../time';
import { RequestContext } from '../request.context';
import { ids } from '../ids';

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
        id: ids.uniqueShortId()
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
          id: ids.uniqueShortId()
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

    const MAX_PAGE_SIZE = 500;
    const DEFAULT_PAGE_SIZE = 200;

    const page = params.pageRequest.page;
    const page_size =
      params.pageRequest.page_size < 1
        ? DEFAULT_PAGE_SIZE
        : params.pageRequest.page_size > MAX_PAGE_SIZE
          ? MAX_PAGE_SIZE
          : params.pageRequest.page_size;

    const offsetVal = (page - 1) * page_size;
    const limitVal = page_size + 1; // “hasNextPage” sentinel

    // --- Helpers -------------------------------------------------------------

    const orderDir = params.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // We’ll fetch IDs+created_at in each branch, then join once at the end.
    // Size each branch limit only as large as needed for the page we’ll return.
    // A small cushion (~1.5× spread over branches) handles interleaving across branches.
    const numBranches = params.profile_id
      ? params.includeProfileIdToIncoming
        ? 3
        : 2
      : 1;

    const branchCushion = 1.5;
    const perBranchLimit = Math.min(
      Math.max(
        // at least a few rows per branch
        16,
        Math.ceil(
          ((limitVal + offsetVal) * branchCushion) / Math.max(1, numBranches)
        )
      ),
      1000 // hard cap
    );

    // Correct index names per branch (IMPORTANT: use index *names*, not columns)
    const indexNameForMatchColumn: Record<string, string> = {
      profile_id: 'idx_pal_profile_type_created_at', // (profile_id, type, created_at)
      proxy_id: 'idx_pal_proxy_type_created_at', // (proxy_id,   type, created_at) <-- add this
      target_id: 'idx_pal_target_type_created_at' // (target_id,  type, created_at) <-- add this
    };

    // Fallbacks if you haven’t created the two new indexes yet:
    const fallbackIndexForMatchColumn: Record<string, string> = {
      proxy_id: 'IDX_9b160d0fc9a4d05fcf63bc5b7c', // (proxy_id, additional_data_1, type, created_at)
      target_id: 'IDX_9977cecaf54d9afa5cf1407f22' // (target_id, additional_data_1, type, created_at)
    };

    const groupPieces = await (async () => {
      if (!params.group_id)
        return { join: '', where: '', params: {} as Record<string, any> };
      const viewResult = await this.userGroupsService.getSqlAndParamsByGroupId(
        params.group_id,
        ctx
      );
      if (viewResult === null)
        return { join: '', where: '', params: {} as Record<string, any> }; // nothing to filter
      return {
        join: ` JOIN ${UserGroupsService.GENERATED_VIEW} group_view ON group_view.profile_id = pa_logs.profile_id `,
        where: viewResult.sql || '',
        params: { ...(viewResult.params || {}) }
      };
    })();

    // Build one branch that returns only (id, created_at)
    const buildIdsBranch = (
      matchColumn: 'profile_id' | 'proxy_id' | 'target_id'
    ) => {
      const p: Record<string, any> = { ...groupPieces.params };

      // Choose the best available index; prefer the new composite, otherwise fallback
      const idxName =
        indexNameForMatchColumn[matchColumn] ||
        fallbackIndexForMatchColumn[matchColumn];

      // Base WHERE (note: no WHERE 1=1; cleaner strings)
      let sql = '';
      if (groupPieces.where) sql += `${groupPieces.where} `;

      sql += `
      SELECT /*+ INDEX(pa_logs ${idxName}) */
             pa_logs.id, pa_logs.created_at
      FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs
      ${groupPieces.join}
      FORCE INDEX (${idxName})
      WHERE pa_logs.${matchColumn} = :profile_id
    `;
      p.profile_id = params.profile_id;

      if (params.rating_matter) {
        sql += ` AND pa_logs.additional_data_1 = :rating_matter`;
        p.rating_matter = params.rating_matter;
      }
      if (params.category) {
        sql += ` AND pa_logs.additional_data_2 = :rating_category`;
        p.rating_category = params.category;
      }
      if (params.target_id) {
        sql += ` AND pa_logs.target_id = :target_id`;
        p.target_id = params.target_id;
      }
      if (params.type?.length) {
        sql += ` AND pa_logs.type IN (:type)`;
        p.type = params.type;
      }

      // Optional: bound time if you generally care about recent logs
      // if (params.since) { sql += ` AND pa_logs.created_at >= :since`; p.since = params.since; }

      sql += ` ORDER BY pa_logs.created_at ${orderDir} LIMIT ${perBranchLimit}`;
      return { sql, params: p };
    };

    // --- Build the query -----------------------------------------------------

    let finalSql: string;
    let finalParams: Record<string, any>;

    if (params.profile_id) {
      const branches: string[] = [];
      const branchParams: Record<string, any>[] = [];

      const cols: ('profile_id' | 'proxy_id' | 'target_id')[] =
        params.includeProfileIdToIncoming
          ? ['profile_id', 'proxy_id', 'target_id']
          : ['profile_id', 'proxy_id'];

      for (const c of cols) {
        const b = buildIdsBranch(c);
        branches.push(`(${b.sql})`);
        branchParams.push(b.params);
      }

      // UNION only ids+created_at, then fetch rows once
      finalSql = `
      WITH ids AS (
        ${branches.join('\nUNION ALL\n')}
      )
      SELECT pa_logs.*
      FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs
      JOIN ids USING (id)
      ORDER BY pa_logs.created_at ${orderDir}
      LIMIT :limit OFFSET :offset
    `;

      finalParams = { limit: limitVal, offset: offsetVal };
      for (const bp of branchParams) {
        for (const [k, v] of Object.entries(bp)) finalParams[k] = v;
      }
    } else {
      // No profile_id: single scan path (keep it simple)
      const p: Record<string, any> = { ...groupPieces.params };

      let single = '';
      if (groupPieces.where) single += `${groupPieces.where} `;

      single += `
      SELECT pa_logs.id, pa_logs.created_at
      FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs
      ${groupPieces.join}
      WHERE 1=1
    `;

      if (params.rating_matter) {
        single += ` AND pa_logs.additional_data_1 = :rating_matter`;
        p.rating_matter = params.rating_matter;
      }
      if (params.category) {
        single += ` AND pa_logs.additional_data_2 = :rating_category`;
        p.rating_category = params.category;
      }
      if (params.target_id) {
        single += ` AND pa_logs.target_id = :target_id`;
        p.target_id = params.target_id;
      }
      if (params.type?.length) {
        single += ` AND pa_logs.type IN (:type)`;
        p.type = params.type;
      }

      // If this path is hot, add a compound index that matches those filters.
      single += ` ORDER BY pa_logs.created_at ${orderDir} LIMIT ${perBranchLimit}`;

      finalSql = `
      WITH ids AS (
        ${single}
      )
      SELECT pa_logs.*
      FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs
      JOIN ids USING (id)
      ORDER BY pa_logs.created_at ${orderDir}
      LIMIT :limit OFFSET :offset
    `;

      finalParams = { ...p, limit: limitVal, offset: offsetVal };
    }

    // Execute
    const rows = await this.db.execute<
      Omit<ProfileActivityLog, 'created_at'> & { created_at: string }
    >(finalSql, finalParams);

    const result = rows.map((r) => ({
      ...r,
      created_at: new Date(r.created_at)
    }));

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
