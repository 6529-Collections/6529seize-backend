import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import { randomInt } from 'crypto';
import {
  DROP_LOG_TYPES,
  isTargetOfTypeDrop,
  ProfileActivityLog,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';
import {
  PROFILE_LATEST_LOG_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  WAVES_TABLE
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
import { waveReadAccessSql } from '@/waves/wave-read-access-sql';
import {
  anonymousCompetitionEntrySql,
  competitionAnonymityViewerId
} from '@/competitions/competition-anonymity';

const mysql = require('mysql');

const PROFILE_LATEST_LOG_RETRY_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT'
]);
const PROFILE_LATEST_LOG_RETRY_DELAYS_MS = [25, 75];
const PROFILE_LATEST_LOG_RETRY_JITTER_MS = 25;

// Rows of these types target a drop and store the drop's wave id in
// additional_data_2.
const WAVE_SCOPED_DROP_LOG_TYPES: readonly ProfileActivityLogType[] = [
  ...DROP_LOG_TYPES,
  ProfileActivityLogType.DROP_REACTED
];
const WAVE_ACCESS_DROP_LOG_TYPES_PARAM = 'wave_access_drop_log_types';
const WAVE_ACCESS_RATING_EDIT_TYPE_PARAM = 'wave_access_rating_edit_type';
const WAVE_ACCESS_WAVE_REP_MATTER_PARAM = 'wave_access_wave_rep_matter';
const WAVE_ACCESS_GROUP_IDS_PARAM = 'wave_access_group_ids';

function isWaveScopedLogType(type: ProfileActivityLogType): boolean {
  return (
    type === ProfileActivityLogType.RATING_EDIT ||
    WAVE_SCOPED_DROP_LOG_TYPES.includes(type)
  );
}

/**
 * Log rows tied to a wave (drop activity, and wave rep ratings whose target is
 * the wave) are returned only when the viewer can read that wave and its
 * parent. Other rows are unaffected. No condition is needed when the requested
 * types cannot include wave-scoped rows.
 */
export function buildProfileLogWaveAccessFilter({
  types,
  eligibleGroupIds
}: {
  types?: ProfileActivityLogType[];
  eligibleGroupIds: string[];
}): { conditions: string[]; params: Record<string, any> } {
  if (types?.length && !types.some(isWaveScopedLogType)) {
    return { conditions: [], params: {} };
  }
  const hasEligibleGroups = eligibleGroupIds.length > 0;
  const readableWave = (waveIdColumn: string) => `exists (
        select 1 from ${WAVES_TABLE} pa_log_wave
        where pa_log_wave.id = ${waveIdColumn}
          and ${waveReadAccessSql('pa_log_wave', hasEligibleGroups, WAVE_ACCESS_GROUP_IDS_PARAM)}
      )`;
  return {
    conditions: [
      `(case
      when pa_logs.type in (:${WAVE_ACCESS_DROP_LOG_TYPES_PARAM})
        then ${readableWave('pa_logs.additional_data_2')}
      when pa_logs.type = :${WAVE_ACCESS_RATING_EDIT_TYPE_PARAM}
        and pa_logs.additional_data_1 = :${WAVE_ACCESS_WAVE_REP_MATTER_PARAM}
        then ${readableWave('pa_logs.target_id')}
      else true
    end)`
    ],
    params: {
      [WAVE_ACCESS_DROP_LOG_TYPES_PARAM]: [...WAVE_SCOPED_DROP_LOG_TYPES],
      [WAVE_ACCESS_RATING_EDIT_TYPE_PARAM]: ProfileActivityLogType.RATING_EDIT,
      [WAVE_ACCESS_WAVE_REP_MATTER_PARAM]: RateMatter.WAVE_REP,
      ...(hasEligibleGroups
        ? { [WAVE_ACCESS_GROUP_IDS_PARAM]: eligibleGroupIds }
        : {})
    }
  };
}

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
    try {
      const currentTime = await this.insertLogEntry(
        log,
        connectionHolder,
        timer
      );
      await this.touchLatestActivity(
        log.profile_id,
        currentTime,
        connectionHolder,
        timer
      );
    } finally {
      timer?.stop('ProfileActivityLogsDb->insert');
    }
  }

  public async insertLogEntry(
    log: Omit<ProfileActivityLog, 'id' | 'created_at'>,
    connectionHolder: ConnectionWrapper<any>,
    timer?: Timer
  ): Promise<Date> {
    timer?.start('ProfileActivityLogsDb->insertLogEntry');
    const currentTime = Time.now().toDate();
    try {
      await this.db.execute(
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
      );
    } finally {
      timer?.stop('ProfileActivityLogsDb->insertLogEntry');
    }
    return currentTime;
  }

  public async touchLatestActivity(
    profileId: string,
    latestActivity: Date,
    connectionHolder?: ConnectionWrapper<any>,
    timer?: Timer
  ): Promise<void> {
    timer?.start('ProfileActivityLogsDb->touchLatestActivity');
    try {
      const touchLatestActivity = async () => {
        await this.db.execute(
          `insert into ${PROFILE_LATEST_LOG_TABLE} (profile_id, latest_activity) values (:profileId, :latestActivity) on duplicate key update latest_activity = greatest(latest_activity, :latestActivity)`,
          { profileId, latestActivity },
          connectionHolder ? { wrappedConnection: connectionHolder } : undefined
        );
      };

      if (connectionHolder) {
        await touchLatestActivity();
        return;
      }

      await this.executeWithProfileLatestRetry(touchLatestActivity);
    } finally {
      timer?.stop('ProfileActivityLogsDb->touchLatestActivity');
    }
  }

  private async executeWithProfileLatestRetry(
    executable: () => Promise<void>
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= PROFILE_LATEST_LOG_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      try {
        await executable();
        return;
      } catch (error) {
        if (
          !this.isRetryableProfileLatestLogError(error) ||
          attempt === PROFILE_LATEST_LOG_RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        await this.sleep(this.getProfileLatestRetryDelayMs(attempt));
      }
    }
  }

  private getProfileLatestRetryDelayMs(attempt: number): number {
    return (
      PROFILE_LATEST_LOG_RETRY_DELAYS_MS[attempt] +
      randomInt(PROFILE_LATEST_LOG_RETRY_JITTER_MS)
    );
  }

  private isRetryableProfileLatestLogError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && PROFILE_LATEST_LOG_RETRY_CODES.has(code);
  }

  private async sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
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

    // Filter before each branch limit so pagination stays exact.
    const waveAccess = buildProfileLogWaveAccessFilter({
      types: params.type,
      eligibleGroupIds: params.viewer_eligible_group_ids
    });
    // Profile-scoped drop logs expose their actor and raw author IDs. Keep
    // anonymous entries out of this surface before every branch's page limit.
    if (
      !params.type?.length ||
      params.type.some((type) => WAVE_SCOPED_DROP_LOG_TYPES.includes(type))
    ) {
      waveAccess.conditions.push(`(pa_logs.type not in (:anonymityDropLogTypes)
        or not exists (
          select 1 from ${COMPETITION_ENTRIES_TABLE} anonymous_log_entry
          join ${COMPETITIONS_TABLE} anonymous_log_competition
            on anonymous_log_competition.id = anonymous_log_entry.competition_id
          where anonymous_log_entry.drop_id = pa_logs.target_id
            and ${anonymousCompetitionEntrySql('anonymous_log_entry', 'anonymous_log_competition')}
            and anonymous_log_entry.submitter_id <> coalesce(:anonymityViewerId, '')
        ))`);
      waveAccess.params.anonymityDropLogTypes = [...WAVE_SCOPED_DROP_LOG_TYPES];
      waveAccess.params.anonymityViewerId =
        competitionAnonymityViewerId(ctx) ?? null;
    }

    // Build one branch that returns only (id, created_at)
    const buildIdsBranch = (
      matchColumn: 'profile_id' | 'proxy_id' | 'target_id'
    ) => {
      const p: Record<string, any> = {
        ...groupPieces.params,
        ...waveAccess.params
      };
      const paramPrefix = `b_${matchColumn}`;

      // Choose the best available index; prefer the new composite, otherwise fallback
      const idxName =
        indexNameForMatchColumn[matchColumn] ||
        fallbackIndexForMatchColumn[matchColumn];

      const baseConditions: string[] = [];
      baseConditions.push(
        `pa_logs.${matchColumn} = :${paramPrefix}_profile_id`
      );
      p[`${paramPrefix}_profile_id`] = params.profile_id;

      if (params.rating_matter) {
        baseConditions.push(
          `pa_logs.additional_data_1 = :${paramPrefix}_rating_matter`
        );
        p[`${paramPrefix}_rating_matter`] = params.rating_matter;
      }
      if (params.category) {
        baseConditions.push(
          `pa_logs.additional_data_2 = :${paramPrefix}_rating_category`
        );
        p[`${paramPrefix}_rating_category`] = params.category;
      }
      if (params.target_id) {
        baseConditions.push(`pa_logs.target_id = :${paramPrefix}_target_id`);
        p[`${paramPrefix}_target_id`] = params.target_id;
      }
      baseConditions.push(...waveAccess.conditions);

      const buildSingleTypeSelect = (typeParamName?: string) => {
        let typeCondition = '';
        if (typeParamName) {
          typeCondition = ` AND pa_logs.type = :${typeParamName}`;
        }
        return `
          SELECT pa_logs.id, pa_logs.created_at
          FROM ${PROFILES_ACTIVITY_LOGS_TABLE} pa_logs FORCE INDEX (${idxName})
          ${groupPieces.join}
          WHERE ${baseConditions.join(' AND ')}${typeCondition}
          ORDER BY pa_logs.created_at ${orderDir}
          LIMIT ${perBranchLimit}
        `;
      };

      // For multi-type filters, fan out by type and limit each type branch first.
      // This avoids large IN-range scans on hot profiles while preserving exact top-K semantics.
      if (params.type?.length && params.type.length > 1) {
        const typeBranches: string[] = [];
        params.type.forEach((type, idx) => {
          const typeParamName = `${paramPrefix}_type_${idx}`;
          p[typeParamName] = type;
          typeBranches.push(`(${buildSingleTypeSelect(typeParamName)})`);
        });
        let sql = '';
        if (groupPieces.where) sql += `${groupPieces.where} `;
        sql += `
          SELECT ids_by_type.id, ids_by_type.created_at
          FROM (
            ${typeBranches.join('\nUNION ALL\n')}
          ) ids_by_type
          ORDER BY ids_by_type.created_at ${orderDir}
          LIMIT ${perBranchLimit}
        `;
        return { sql, params: p };
      }

      // Single type (or no type) keeps the simpler path.
      let sql = '';
      if (groupPieces.where) sql += `${groupPieces.where} `;
      if (params.type?.length === 1) {
        const typeParamName = `${paramPrefix}_type_0`;
        p[typeParamName] = params.type[0];
        sql += buildSingleTypeSelect(typeParamName);
      } else {
        sql += buildSingleTypeSelect();
      }
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
      const p: Record<string, any> = {
        ...groupPieces.params,
        ...waveAccess.params
      };

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
      single += waveAccess.conditions
        .map((condition) => ` AND ${condition}`)
        .join('');

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
  // Read-context groups of the viewer; empty for anonymous viewers.
  readonly viewer_eligible_group_ids: string[];
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
