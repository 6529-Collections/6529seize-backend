import {
  IDENTITIES_TABLE,
  MEMBERSHIP_MATERIALIZATION_STATES_TABLE,
  MEMBERSHIP_REFRESH_REQUESTS_TABLE,
  MEMBERSHIP_WATERMARKS_TABLE,
  USER_GROUP_MEMBERS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVES_TABLE,
  XTDH_GRANTS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { MembershipRefreshScope } from '@/entities/IMembershipRefreshRequest';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  ELIGIBILITY_SPEC_VERSION,
  MEMBERSHIP_DEFAULT_BATCH_SIZE,
  MEMBERSHIP_FULL_BACKFILL_WATERMARK,
  MEMBERSHIP_GRANT_BOUNDARY_WATERMARK,
  MEMBERSHIP_MAX_BATCH_SIZE,
  MEMBERSHIP_MAX_REFRESH_ATTEMPTS,
  MEMBERSHIP_MISSING_PROFILE_SWEEP_PAGE_SIZE,
  MEMBERSHIP_MISSING_PROFILE_SWEEP_WATERMARK
} from './membership.constants';
import {
  membershipRefreshProducer,
  MembershipRefreshReason
} from './membership-refresh.producer';

interface MembershipRefreshRequestRow {
  readonly scope: MembershipRefreshScope;
  readonly target_id: string;
  readonly dirty_at: number | string;
  readonly attempts: number;
}

interface IdentityProfileSweepRow {
  readonly consolidation_key: string;
  readonly profile_id: string;
}

export interface RefreshDirtyMembershipsOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface RefreshDirtyMembershipsResult {
  readonly batches: number;
  readonly targets: number;
  readonly hasMore: boolean;
}

export interface RefreshAllMembershipsOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly startAfterGroupId?: string;
  readonly asOfMillis?: number;
}

export interface RefreshAllMembershipsResult {
  readonly batches: number;
  readonly groups: number;
  readonly hasMore: boolean;
  readonly startedAfterGroupId: string | null;
  readonly lastGroupId: string | null;
  readonly asOfMillis: number;
  readonly finalized: boolean;
}

export class MembershipMaterializationService extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public async refreshProfile(
    profileId: string,
    capturedRequest?: MembershipRefreshRequestRow,
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!(await this.profileExists(profileId, ctx))) {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const transactionContext = { ...ctx, connection };
        await this.db.execute(
          `delete from ${USER_GROUP_MEMBERS_TABLE} where profile_id = :profileId`,
          { profileId },
          { wrappedConnection: connection }
        );
        await this.db.execute(
          `
          delete from ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE}
          where scope = :profileScope and target_id = :profileId
          `,
          { profileScope: MembershipRefreshScope.PROFILE, profileId },
          { wrappedConnection: connection }
        );
        await this.deleteCapturedRequest(capturedRequest, transactionContext);
      });
      return;
    }
    const eligibleGroupIds =
      await userGroupsService.computeGroupsUserIsEligibleForUncached(
        profileId,
        ctx.timer
      );
    const asOfMillis = Time.currentMillis();
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const transactionContext = { ...ctx, connection };
      await this.db.execute(
        `delete from ${USER_GROUP_MEMBERS_TABLE} where profile_id = :profileId`,
        { profileId },
        { wrappedConnection: connection }
      );
      await this.insertProfileMemberships(
        profileId,
        eligibleGroupIds,
        asOfMillis,
        transactionContext
      );
      await this.upsertMaterializationState(
        MembershipRefreshScope.PROFILE,
        profileId,
        asOfMillis,
        transactionContext
      );
      await this.deleteCapturedRequest(capturedRequest, transactionContext);
    });
    await userGroupsService.invalidateGroupsUserIsEligibleFor(profileId);
  }

  private async profileExists(
    profileId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const rows = await this.db.execute<{ readonly profile_id: string }>(
      `
      select profile_id
      from ${IDENTITIES_TABLE}
      where profile_id = :profileId
      limit 1
      `,
      { profileId },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows.length > 0;
  }

  public async refreshGroup(
    groupId: string,
    capturedRequest?: MembershipRefreshRequestRow,
    ctx: RequestContext = {}
  ): Promise<void> {
    const memberSet =
      await userGroupsService.getSqlAndParamsByGroupIdForSystemBroadcast(
        groupId,
        ctx
      );
    const asOfMillis = Time.currentMillis();
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const transactionContext = { ...ctx, connection };
      await this.db.execute(
        `delete from ${USER_GROUP_MEMBERS_TABLE} where group_id = :groupId`,
        { groupId },
        { wrappedConnection: connection }
      );
      if (memberSet !== null) {
        await this.db.execute(
          `
          insert into ${USER_GROUP_MEMBERS_TABLE}
            (group_id, profile_id, spec_version, as_of_millis)
          ${memberSet.sql}
          select
            :materializedGroupId,
            profile_id,
            :materializedSpecVersion,
            :materializedAsOfMillis
          from ${UserGroupsService.GENERATED_VIEW}
          where profile_id is not null
          `,
          {
            ...memberSet.params,
            materializedGroupId: groupId,
            materializedSpecVersion: ELIGIBILITY_SPEC_VERSION,
            materializedAsOfMillis: asOfMillis
          },
          { wrappedConnection: connection }
        );
      }
      await this.upsertMaterializationState(
        MembershipRefreshScope.GROUP,
        groupId,
        asOfMillis,
        transactionContext
      );
      await this.deleteCapturedRequest(capturedRequest, transactionContext);
    });
  }

  public async refreshDirtyMemberships(
    options: RefreshDirtyMembershipsOptions = {},
    ctx: RequestContext = {}
  ): Promise<RefreshDirtyMembershipsResult> {
    await this.captureGrantBoundaryChanges(ctx);
    await this.captureMissingProfilesPage(ctx);
    const batchSize = this.getBatchSize(options.batchSize);
    const maxBatches = Math.max(
      1,
      options.maxBatches ?? Number.MAX_SAFE_INTEGER
    );
    const processedTargets: MembershipRefreshRequestRow[] = [];
    let batches = 0;
    let targets = 0;

    while (batches < maxBatches) {
      const rows = await this.getDirtyRequests(
        batchSize,
        processedTargets,
        ctx
      );
      if (!rows.length) {
        break;
      }
      processedTargets.push(...rows);
      for (const row of rows) {
        await this.processDirtyRequest(row, ctx);
      }
      batches += 1;
      targets += rows.length;
      if (rows.length < batchSize) {
        break;
      }
    }

    return {
      batches,
      targets,
      hasMore: await this.hasDirtyRequests(ctx)
    };
  }

  public async refreshAllMemberships(
    options: RefreshAllMembershipsOptions = {},
    ctx: RequestContext = {}
  ): Promise<RefreshAllMembershipsResult> {
    const batchSize = this.getBatchSize(options.batchSize);
    const maxBatches = Math.max(
      1,
      options.maxBatches ?? Number.MAX_SAFE_INTEGER
    );
    const startedAfterGroupId = options.startAfterGroupId?.trim() || null;
    const asOfMillis = options.asOfMillis ?? Time.currentMillis();
    if (options.asOfMillis === undefined) {
      await this.initializeFullBackfill(asOfMillis, ctx);
    }
    let lastGroupId = startedAfterGroupId;
    let batches = 0;
    let groups = 0;
    let hasMore = false;

    while (batches < maxBatches) {
      const groupIds = await this.getWaveRelatedGroupIdsPage(
        lastGroupId,
        batchSize,
        ctx
      );
      if (!groupIds.length) {
        hasMore = false;
        break;
      }
      for (const groupId of groupIds) {
        await this.refreshGroup(groupId, undefined, ctx);
      }
      batches += 1;
      groups += groupIds.length;
      lastGroupId = groupIds[groupIds.length - 1];
      hasMore = groupIds.length === batchSize;
      if (!hasMore) {
        break;
      }
    }

    const hitInvocationCap = batches >= maxBatches && hasMore;
    if (hitInvocationCap) {
      return {
        batches,
        groups,
        hasMore: true,
        startedAfterGroupId,
        lastGroupId,
        asOfMillis,
        finalized: false
      };
    }

    await this.finalizeFullBackfill(asOfMillis, ctx);
    return {
      batches,
      groups,
      hasMore: false,
      startedAfterGroupId,
      lastGroupId,
      asOfMillis,
      finalized: true
    };
  }

  private async processDirtyRequest(
    row: MembershipRefreshRequestRow,
    ctx: RequestContext
  ): Promise<void> {
    try {
      if (row.scope === MembershipRefreshScope.PROFILE) {
        await this.refreshProfile(row.target_id, row, ctx);
      } else {
        await this.refreshGroup(row.target_id, row, ctx);
      }
    } catch (error) {
      await this.recordRefreshFailure(row, error, ctx);
      const attempts = Number(row.attempts) + 1;
      this.logger.error(`Failed to refresh dirty membership target`, {
        scope: row.scope,
        targetId: row.target_id,
        dirtyAt: row.dirty_at,
        attempts,
        error
      });
      if (attempts >= MEMBERSHIP_MAX_REFRESH_ATTEMPTS) {
        this.logger.error(`MEMBERSHIP_REFRESH_POISON`, {
          scope: row.scope,
          targetId: row.target_id,
          dirtyAt: row.dirty_at,
          attempts
        });
      }
    }
  }

  private async insertProfileMemberships(
    profileId: string,
    groupIds: string[],
    asOfMillis: number,
    ctx: RequestContext
  ): Promise<void> {
    const distinctGroupIds = Array.from(new Set(groupIds));
    for (
      let offset = 0;
      offset < distinctGroupIds.length;
      offset += MEMBERSHIP_MAX_BATCH_SIZE
    ) {
      const groupIdChunk = distinctGroupIds.slice(
        offset,
        offset + MEMBERSHIP_MAX_BATCH_SIZE
      );
      const params = groupIdChunk.reduce<Record<string, string | number>>(
        (acc, groupId, index) => {
          acc[`groupId${index}`] = groupId;
          return acc;
        },
        {
          profileId,
          specVersion: ELIGIBILITY_SPEC_VERSION,
          asOfMillis
        }
      );
      await this.db.execute(
        `
        insert into ${USER_GROUP_MEMBERS_TABLE}
          (group_id, profile_id, spec_version, as_of_millis)
        values ${groupIdChunk
          .map(
            (_, index) =>
              `(:groupId${index}, :profileId, :specVersion, :asOfMillis)`
          )
          .join(', ')}
        `,
        params,
        { wrappedConnection: ctx.connection }
      );
    }
  }

  private async upsertMaterializationState(
    scope: MembershipRefreshScope,
    targetId: string,
    asOfMillis: number,
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
      insert into ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE}
        (scope, target_id, spec_version, as_of_millis, updated_at_millis)
      values (:scope, :targetId, :specVersion, :asOfMillis, :updatedAtMillis)
      as new
      on duplicate key update
        spec_version = new.spec_version,
        as_of_millis = new.as_of_millis,
        updated_at_millis = new.updated_at_millis
      `,
      {
        scope,
        targetId,
        specVersion: ELIGIBILITY_SPEC_VERSION,
        asOfMillis,
        updatedAtMillis: now
      },
      { wrappedConnection: ctx.connection }
    );
  }

  private async deleteCapturedRequest(
    row: MembershipRefreshRequestRow | undefined,
    ctx: RequestContext
  ): Promise<void> {
    if (!row) {
      return;
    }
    await this.db.execute(
      `
      delete from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
      where scope = :scope
        and target_id = :targetId
        and dirty_at = :dirtyAt
      `,
      {
        scope: row.scope,
        targetId: row.target_id,
        dirtyAt: row.dirty_at
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async recordRefreshFailure(
    row: MembershipRefreshRequestRow,
    error: unknown,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `
      update ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
      set
        attempts = attempts + 1,
        last_error = :lastError,
        updated_at = :updatedAt
      where scope = :scope
        and target_id = :targetId
        and dirty_at = :dirtyAt
      `,
      {
        scope: row.scope,
        targetId: row.target_id,
        dirtyAt: row.dirty_at,
        lastError: this.errorToString(error).slice(0, 2000),
        updatedAt: Time.currentMillis()
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async getDirtyRequests(
    batchSize: number,
    excludedRows: MembershipRefreshRequestRow[],
    ctx: RequestContext
  ): Promise<MembershipRefreshRequestRow[]> {
    const excludedClause = excludedRows.length
      ? `where (scope, target_id) not in (${excludedRows
          .map(
            (_, index) => `(:excludedScope${index}, :excludedTargetId${index})`
          )
          .join(', ')})`
      : '';
    const params = excludedRows.reduce<Record<string, string | number>>(
      (acc, row, index) => {
        acc[`excludedScope${index}`] = row.scope;
        acc[`excludedTargetId${index}`] = row.target_id;
        return acc;
      },
      {
        batchSize,
        maxAttempts: MEMBERSHIP_MAX_REFRESH_ATTEMPTS
      }
    );
    return await this.db.execute<MembershipRefreshRequestRow>(
      `
      select scope, target_id, dirty_at, attempts
      from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
      ${excludedClause || 'where true'}
        and attempts < :maxAttempts
      order by dirty_at asc, scope asc, target_id asc
      limit :batchSize
      `,
      params,
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async hasDirtyRequests(ctx: RequestContext): Promise<boolean> {
    const rows = await this.db.execute<{ readonly target_id: string }>(
      `
      select target_id
      from ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
      where attempts < :maxAttempts
      limit 1
      `,
      { maxAttempts: MEMBERSHIP_MAX_REFRESH_ATTEMPTS },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows.length > 0;
  }

  private async getWaveRelatedGroupIdsPage(
    afterGroupId: string | null,
    batchSize: number,
    ctx: RequestContext
  ): Promise<string[]> {
    const afterClause = afterGroupId ? 'and id > :afterGroupId' : '';
    const rows = await this.db.execute<{ readonly id: string }>(
      `
      select distinct id
      from (
        select visibility_group_id as id from ${WAVES_TABLE}
        union all
        select admin_group_id as id from ${WAVES_TABLE}
        union all
        select chat_group_id as id from ${WAVES_TABLE}
        union all
        select participation_group_id as id from ${WAVES_TABLE}
        union all
        select voting_group_id as id from ${WAVES_TABLE}
        union all
        select community_group_id as id from ${WAVE_CURATIONS_TABLE}
      ) wave_groups
      where id is not null
        ${afterClause}
      order by id asc
      limit ${batchSize}
      `,
      afterGroupId ? { afterGroupId } : undefined,
      { wrappedConnection: ctx.connection }
    );
    return rows.map((row) => row.id);
  }

  private async finalizeFullBackfill(
    asOfMillis: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const now = Time.currentMillis();
      const transactionContext = { ...ctx, connection };
      await this.pruneNonWaveMemberships(transactionContext);
      await this.captureGrantBoundaryChangesBetween(
        asOfMillis,
        now,
        transactionContext
      );
      await this.upsertWatermark(
        MEMBERSHIP_GRANT_BOUNDARY_WATERMARK,
        now,
        JSON.stringify({ specVersion: ELIGIBILITY_SPEC_VERSION }),
        transactionContext
      );
      await this.upsertWatermark(
        MEMBERSHIP_FULL_BACKFILL_WATERMARK,
        asOfMillis,
        JSON.stringify({
          specVersion: ELIGIBILITY_SPEC_VERSION,
          completedAtMillis: now
        }),
        transactionContext
      );
    });
  }

  private async initializeFullBackfill(
    asOfMillis: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const now = Time.currentMillis();
      await this.db.execute(
        `
        delete from ${MEMBERSHIP_WATERMARKS_TABLE}
        where dimension = :dimension
        `,
        { dimension: MEMBERSHIP_FULL_BACKFILL_WATERMARK },
        { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
      );
      await this.db.execute(
        `
        insert into ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE}
          (scope, target_id, spec_version, as_of_millis, updated_at_millis)
        select
          :profileScope,
          identities.profile_id,
          :specVersion,
          :asOfMillis,
          :updatedAtMillis
        from ${IDENTITIES_TABLE} identities
        where identities.profile_id is not null
        on duplicate key update
          spec_version = values(spec_version),
          as_of_millis = values(as_of_millis),
          updated_at_millis = values(updated_at_millis)
        `,
        {
          profileScope: MembershipRefreshScope.PROFILE,
          specVersion: ELIGIBILITY_SPEC_VERSION,
          asOfMillis,
          updatedAtMillis: now
        },
        { wrappedConnection: connection }
      );
    });
  }

  private async captureGrantBoundaryChanges(
    ctx: RequestContext
  ): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const transactionContext = { ...ctx, connection };
      const rows = await this.db.execute<{
        readonly watermark_millis: string;
      }>(
        `
        select watermark_millis
        from ${MEMBERSHIP_WATERMARKS_TABLE}
        where dimension = :grantBoundaryWatermark
        for update
        `,
        { grantBoundaryWatermark: MEMBERSHIP_GRANT_BOUNDARY_WATERMARK },
        { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
      );
      if (!rows.length) {
        return;
      }
      const fromMillis = Number(rows[0].watermark_millis);
      const toMillis = Time.currentMillis();
      await this.captureGrantBoundaryChangesBetween(
        fromMillis,
        toMillis,
        transactionContext
      );
      await this.upsertWatermark(
        MEMBERSHIP_GRANT_BOUNDARY_WATERMARK,
        toMillis,
        JSON.stringify({ specVersion: ELIGIBILITY_SPEC_VERSION }),
        transactionContext
      );
    });
  }

  private async captureMissingProfilesPage(ctx: RequestContext): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const transactionContext = { ...ctx, connection };
      const fullBackfillRows = await this.db.execute<{
        readonly dimension: string;
      }>(
        `
        select dimension
        from ${MEMBERSHIP_WATERMARKS_TABLE}
        where dimension = :fullBackfillWatermark
        limit 1
        `,
        { fullBackfillWatermark: MEMBERSHIP_FULL_BACKFILL_WATERMARK },
        { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
      );
      if (!fullBackfillRows.length) {
        return;
      }

      const sweepRows = await this.db.execute<{
        readonly detail: string | null;
      }>(
        `
        select detail
        from ${MEMBERSHIP_WATERMARKS_TABLE}
        where dimension = :missingProfileSweepWatermark
        for update
        `,
        {
          missingProfileSweepWatermark:
            MEMBERSHIP_MISSING_PROFILE_SWEEP_WATERMARK
        },
        { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
      );
      const cursor = sweepRows[0]?.detail ?? null;
      const identityRows = await this.getIdentityProfileSweepPage(
        cursor,
        transactionContext
      );
      const profileIds = Array.from(
        new Set(identityRows.map((row) => row.profile_id))
      );
      const missingProfileIds = await this.getProfileIdsMissingState(
        profileIds,
        transactionContext
      );
      await membershipRefreshProducer.markProfilesDirty(
        missingProfileIds,
        MembershipRefreshReason.GROUP_CHANGED,
        transactionContext
      );

      const hasAnotherPage =
        identityRows.length === MEMBERSHIP_MISSING_PROFILE_SWEEP_PAGE_SIZE;
      const nextCursor = hasAnotherPage
        ? identityRows[identityRows.length - 1].consolidation_key
        : null;
      await this.upsertWatermark(
        MEMBERSHIP_MISSING_PROFILE_SWEEP_WATERMARK,
        Time.currentMillis(),
        nextCursor,
        transactionContext
      );
    });
  }

  private async getIdentityProfileSweepPage(
    cursor: string | null,
    ctx: RequestContext
  ): Promise<IdentityProfileSweepRow[]> {
    const cursorClause = cursor
      ? 'and consolidation_key > :consolidationKeyCursor'
      : '';
    return await this.db.execute<IdentityProfileSweepRow>(
      `
      select consolidation_key, profile_id
      from ${IDENTITIES_TABLE} force index (primary)
      where profile_id is not null
        ${cursorClause}
      order by consolidation_key asc
      limit ${MEMBERSHIP_MISSING_PROFILE_SWEEP_PAGE_SIZE}
      `,
      cursor ? { consolidationKeyCursor: cursor } : undefined,
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async getProfileIdsMissingState(
    profileIds: string[],
    ctx: RequestContext
  ): Promise<string[]> {
    const missingProfileIds = new Set<string>();
    for (
      let offset = 0;
      offset < profileIds.length;
      offset += MEMBERSHIP_MAX_BATCH_SIZE
    ) {
      const profileIdChunk = profileIds.slice(
        offset,
        offset + MEMBERSHIP_MAX_BATCH_SIZE
      );
      if (!profileIdChunk.length) {
        continue;
      }
      const rows = await this.db.execute<{ readonly target_id: string }>(
        `
        select target_id
        from ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE}
        where scope = :profileScope
          and spec_version = :specVersion
          and target_id in (:profileIds)
        `,
        {
          profileScope: MembershipRefreshScope.PROFILE,
          specVersion: ELIGIBILITY_SPEC_VERSION,
          profileIds: profileIdChunk
        },
        {
          wrappedConnection: ctx.connection,
          forcePool: DbPoolName.WRITE
        }
      );
      const materializedProfileIds = new Set(rows.map((row) => row.target_id));
      profileIdChunk.forEach((profileId) => {
        if (!materializedProfileIds.has(profileId)) {
          missingProfileIds.add(profileId);
        }
      });
    }
    return Array.from(missingProfileIds);
  }

  private async captureGrantBoundaryChangesBetween(
    fromMillis: number,
    toMillis: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `
      insert into ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
        (scope, target_id, reason, dirty_at, attempts, last_error, created_at, updated_at)
      select
        :groupScope,
        community_group.id,
        :reason,
        :dirtyAt,
        0,
        null,
        :createdAt,
        :updatedAt
      from ${USER_GROUPS_TABLE} community_group
      join ${XTDH_GRANTS_TABLE} grants
        on grants.id = community_group.is_beneficiary_of_grant_id
      where community_group.visible = true
        and (
          (grants.valid_from > :fromMillis and grants.valid_from <= :toMillis)
          or
          (grants.valid_to > :fromMillis and grants.valid_to <= :toMillis)
        )
      on duplicate key update
        reason = values(reason),
        dirty_at = greatest(
          values(dirty_at),
          ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}.dirty_at + 1
        ),
        attempts = 0,
        last_error = null,
        updated_at = values(updated_at)
      `,
      {
        groupScope: MembershipRefreshScope.GROUP,
        reason: MembershipRefreshReason.GRANT_CHANGED,
        dirtyAt: toMillis,
        createdAt: toMillis,
        updatedAt: toMillis,
        fromMillis,
        toMillis
      },
      { wrappedConnection: ctx.connection }
    );
  }

  private async upsertWatermark(
    dimension: string,
    watermarkMillis: number,
    detail: string | null,
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
      insert into ${MEMBERSHIP_WATERMARKS_TABLE}
        (dimension, watermark_millis, detail, updated_at_millis)
      values (:dimension, :watermarkMillis, :detail, :updatedAtMillis)
      as new
      on duplicate key update
        watermark_millis = new.watermark_millis,
        detail = new.detail,
        updated_at_millis = new.updated_at_millis
      `,
      {
        dimension,
        watermarkMillis,
        detail,
        updatedAtMillis: now
      },
      { wrappedConnection: ctx.connection }
    );
  }

  private async pruneNonWaveMemberships(ctx: RequestContext): Promise<void> {
    const waveGroupIdsSql = `
      select visibility_group_id as id from ${WAVES_TABLE}
      union
      select admin_group_id as id from ${WAVES_TABLE}
      union
      select chat_group_id as id from ${WAVES_TABLE}
      union
      select participation_group_id as id from ${WAVES_TABLE}
      union
      select voting_group_id as id from ${WAVES_TABLE}
      union
      select community_group_id as id from ${WAVE_CURATIONS_TABLE}
    `;
    await this.db.execute(
      `
      delete members
      from ${USER_GROUP_MEMBERS_TABLE} members
      left join (${waveGroupIdsSql}) wave_groups
        on wave_groups.id = members.group_id
      where wave_groups.id is null
      `,
      undefined,
      { wrappedConnection: ctx.connection }
    );
    await this.db.execute(
      `
      delete states
      from ${MEMBERSHIP_MATERIALIZATION_STATES_TABLE} states
      left join (${waveGroupIdsSql}) wave_groups
        on wave_groups.id = states.target_id
      where states.scope = :groupScope
        and wave_groups.id is null
      `,
      { groupScope: MembershipRefreshScope.GROUP },
      { wrappedConnection: ctx.connection }
    );
  }

  private getBatchSize(requestedBatchSize: number | undefined): number {
    return Math.max(
      1,
      Math.min(
        MEMBERSHIP_MAX_BATCH_SIZE,
        requestedBatchSize ?? MEMBERSHIP_DEFAULT_BATCH_SIZE
      )
    );
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }
}

export const membershipMaterializationService =
  new MembershipMaterializationService(dbSupplier);
