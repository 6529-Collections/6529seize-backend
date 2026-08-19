import {
  ATTACHMENTS_TABLE,
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  CONTENT_MODERATION_PROFILE_STATES_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  CONTENT_MODERATION_ROLES_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_MEDIA_TABLE,
  PROFILES_TABLE
} from '@/constants';
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import { env } from '@/env';

const REPORT_RATE_LIMIT_WINDOW = Time.hours(1);
const DEFAULT_REPORTS_PER_HOUR = 100;

export interface DropViewerModerationContext {
  readonly author_blocked: boolean;
  readonly drop_hidden: boolean;
}

export interface DropModerationContext {
  readonly status: DropModerationStatus;
  readonly can_view: boolean;
}

export interface ContentModerationPresentation {
  readonly viewer: DropViewerModerationContext;
  readonly moderation: DropModerationContext;
}

export interface ModerationReportRow {
  readonly id: string;
  readonly drop_id: string;
  readonly reporter_profile_id: string;
  readonly author_profile_id: string;
  readonly reason: ContentReportReason;
  readonly notes: string | null;
  readonly content_snapshot: Record<string, unknown>;
  readonly status: ContentReportStatus;
  readonly ai_recommendation: ContentModerationRecommendation | null;
  readonly ai_category: string | null;
  readonly ai_confidence: number | null;
  readonly ai_rationale: string | null;
  readonly ai_evidence: unknown[] | null;
  readonly ai_policy_version: string | null;
  readonly ai_assessed_at: number | null;
  readonly created_at: number;
  readonly resolved_by_profile_id: string | null;
  readonly resolution_reason: string | null;
  readonly resolved_at: number | null;
}

type ModerationQueueReportRow = ModerationReportRow & {
  readonly report_count: number;
  readonly recommendation_rank: number;
};

type ModerationQueueCursor = {
  readonly recommendationRank: number;
  readonly createdAt: number;
  readonly reportId: string;
};

export interface AiModerationAssessment {
  readonly recommendation: ContentModerationRecommendation;
  readonly category: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly evidence: unknown[];
  readonly policyVersion: string;
}

export interface PrePublicationCheckRecord {
  readonly dropId: string;
  readonly authorProfileId: string;
  readonly operation: 'CREATE' | 'UPDATE';
  readonly deterministicGateVersion: string;
  readonly contentFingerprint: string;
  readonly signal: string | null;
  readonly outcome: PrePublicationCheckOutcome;
  readonly evaluatorVersion: string | null;
  readonly evaluatorResult: Record<string, unknown> | null;
}

export class ContentModerationDb extends LazyDbAccessCompatibleService {
  async blockProfile(
    blockerProfileId: string,
    blockedProfileId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (blockerProfileId === blockedProfileId) {
      throw new BadRequestException(`You can't block your own profile`);
    }
    await this.withTransaction(ctx.connection, async (connection) => {
      await this.assertProfileExists(blockedProfileId, connection);
      const existing = await this.db.oneOrNull<{ id: string }>(
        `
          select id
          from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
          where blocker_profile_id = :blockerProfileId
            and blocked_profile_id = :blockedProfileId
          for update
        `,
        { blockerProfileId, blockedProfileId },
        this.connectionOptions(connection)
      );
      await this.db.execute(
        `
          insert into ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} (
            blocker_profile_id,
            blocked_profile_id,
            created_at
          ) values (
            :blockerProfileId,
            :blockedProfileId,
            :createdAt
          )
          on duplicate key update created_at = values(created_at)
        `,
        {
          blockerProfileId,
          blockedProfileId,
          createdAt: Time.currentMillis()
        },
        this.connectionOptions(connection)
      );
      await this.insertAudit(
        {
          actorProfileId: blockerProfileId,
          action: 'PROFILE_BLOCKED',
          targetProfileId: blockedProfileId,
          previousState: existing ? 'BLOCKED' : 'UNBLOCKED',
          newState: 'BLOCKED'
        },
        connection
      );
    });
  }

  async unblockProfile(
    blockerProfileId: string,
    blockedProfileId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.withTransaction(ctx.connection, async (connection) => {
      const existing = await this.db.oneOrNull<{ id: string }>(
        `
        select id
        from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
        where blocker_profile_id = :blockerProfileId
          and blocked_profile_id = :blockedProfileId
      `,
        { blockerProfileId, blockedProfileId },
        this.connectionOptions(connection)
      );
      await this.db.execute(
        `
        delete from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
        where blocker_profile_id = :blockerProfileId
          and blocked_profile_id = :blockedProfileId
      `,
        { blockerProfileId, blockedProfileId },
        this.connectionOptions(connection)
      );
      await this.insertAudit(
        {
          actorProfileId: blockerProfileId,
          action: 'PROFILE_UNBLOCKED',
          targetProfileId: blockedProfileId,
          previousState: existing ? 'BLOCKED' : 'UNBLOCKED',
          newState: 'UNBLOCKED'
        },
        connection
      );
    });
  }

  async listBlockedProfiles(
    blockerProfileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<
    Array<{
      profile_id: string;
      handle: string | null;
      pfp: string | null;
      blocked_at: number;
    }>
  > {
    return await this.db.execute(
      `
        select
          b.blocked_profile_id as profile_id,
          p.handle,
          p.pfp_url as pfp,
          b.created_at as blocked_at
        from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} b
        left join ${PROFILES_TABLE} p on p.external_id = b.blocked_profile_id
        where b.blocker_profile_id = :blockerProfileId
        order by b.created_at desc
      `,
      { blockerProfileId },
      this.connectionOptions(connection)
    );
  }

  async hideDrop(
    profileId: string,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.withTransaction(ctx.connection, async (connection) => {
      await this.assertDropExists(dropId, connection);
      const existing = await this.db.oneOrNull<{ id: string }>(
        `
        select id
        from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
        where profile_id = :profileId
          and drop_id = :dropId
      `,
        { profileId, dropId },
        this.connectionOptions(connection)
      );
      await this.db.execute(
        `
        insert into ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE} (
          profile_id,
          drop_id,
          created_at
        ) values (
          :profileId,
          :dropId,
          :createdAt
        )
        on duplicate key update created_at = values(created_at)
      `,
        { profileId, dropId, createdAt: Time.currentMillis() },
        this.connectionOptions(connection)
      );
      await this.insertAudit(
        {
          actorProfileId: profileId,
          action: 'DROP_HIDDEN',
          targetDropId: dropId,
          previousState: existing ? 'HIDDEN' : 'SHOWN',
          newState: 'HIDDEN'
        },
        connection
      );
    });
  }

  async unhideDrop(
    profileId: string,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.withTransaction(ctx.connection, async (connection) => {
      const existing = await this.db.oneOrNull<{ id: string }>(
        `
        select id
        from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
        where profile_id = :profileId
          and drop_id = :dropId
      `,
        { profileId, dropId },
        this.connectionOptions(connection)
      );
      await this.db.execute(
        `
        delete from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
        where profile_id = :profileId
          and drop_id = :dropId
      `,
        { profileId, dropId },
        this.connectionOptions(connection)
      );
      await this.insertAudit(
        {
          actorProfileId: profileId,
          action: 'DROP_UNHIDDEN',
          targetDropId: dropId,
          previousState: existing ? 'HIDDEN' : 'SHOWN',
          newState: 'SHOWN'
        },
        connection
      );
    });
  }

  async getPresentations(
    drops: ReadonlyArray<{ id: string; author_id: string }>,
    viewerProfileId: string | null,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ContentModerationPresentation>> {
    if (!drops.length) {
      return {};
    }
    const dropIds = Array.from(new Set(drops.map((drop) => drop.id)));
    const authorIds = Array.from(new Set(drops.map((drop) => drop.author_id)));
    const [stateRows, blockedRows, hiddenRows] = await Promise.all([
      this.db.execute<{ drop_id: string; status: DropModerationStatus }>(
        `
          select drop_id, status
          from ${CONTENT_MODERATION_DROP_STATES_TABLE}
          where drop_id in (:dropIds)
        `,
        { dropIds },
        this.connectionOptions(connection)
      ),
      viewerProfileId
        ? this.db.execute<{ blocked_profile_id: string }>(
            `
              select blocked_profile_id
              from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
              where blocker_profile_id = :viewerProfileId
                and blocked_profile_id in (:authorIds)
            `,
            { viewerProfileId, authorIds },
            this.connectionOptions(connection)
          )
        : Promise.resolve([]),
      viewerProfileId
        ? this.db.execute<{ drop_id: string }>(
            `
              select drop_id
              from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
              where profile_id = :viewerProfileId
                and drop_id in (:dropIds)
            `,
            { viewerProfileId, dropIds },
            this.connectionOptions(connection)
          )
        : Promise.resolve([])
    ]);
    const states = new Map(stateRows.map((row) => [row.drop_id, row.status]));
    const blocked = new Set(blockedRows.map((row) => row.blocked_profile_id));
    const hidden = new Set(hiddenRows.map((row) => row.drop_id));
    return drops.reduce<Record<string, ContentModerationPresentation>>(
      (acc, drop) => {
        const status = states.get(drop.id) ?? DropModerationStatus.VISIBLE;
        acc[drop.id] = {
          viewer: {
            author_blocked: blocked.has(drop.author_id),
            drop_hidden: hidden.has(drop.id)
          },
          moderation: {
            status,
            can_view:
              status === DropModerationStatus.VISIBLE ||
              viewerProfileId === drop.author_id
          }
        };
        return acc;
      },
      {}
    );
  }

  async filterBlockedNotificationRows<
    T extends {
      readonly identity_id: string;
      readonly additional_identity_id: string | null;
    }
  >(notifications: T[], connection?: ConnectionWrapper<any>): Promise<T[]> {
    const blockerIds = Array.from(
      new Set(notifications.map((row) => row.identity_id))
    );
    const actorIds = Array.from(
      new Set(
        notifications
          .map((row) => row.additional_identity_id)
          .filter((id): id is string => id !== null)
      )
    );
    if (!blockerIds.length || !actorIds.length) {
      return notifications;
    }
    const rows = await this.db.execute<{
      blocker_profile_id: string;
      blocked_profile_id: string;
    }>(
      `
        select blocker_profile_id, blocked_profile_id
        from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
        where blocker_profile_id in (:blockerIds)
          and blocked_profile_id in (:actorIds)
      `,
      { blockerIds, actorIds },
      this.connectionOptions(connection)
    );
    const blockedPairs = new Set(
      rows.map((row) => `${row.blocker_profile_id}:${row.blocked_profile_id}`)
    );
    return notifications.filter((notification) => {
      const actorId = notification.additional_identity_id;
      return (
        actorId === null ||
        !blockedPairs.has(`${notification.identity_id}:${actorId}`)
      );
    });
  }

  async getViewerContextsForDrop(
    input: {
      dropId: string;
      authorProfileId: string;
      viewerProfileIds: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, DropViewerModerationContext>> {
    const viewerProfileIds = Array.from(new Set(input.viewerProfileIds));
    if (!viewerProfileIds.length) {
      return {};
    }
    const [blockRows, hiddenRows] = await Promise.all([
      this.db.execute<{ blocker_profile_id: string }>(
        `
          select blocker_profile_id
          from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}
          where blocker_profile_id in (:viewerProfileIds)
            and blocked_profile_id = :authorProfileId
        `,
        { ...input, viewerProfileIds },
        this.connectionOptions(connection)
      ),
      this.db.execute<{ profile_id: string }>(
        `
          select profile_id
          from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}
          where profile_id in (:viewerProfileIds)
            and drop_id = :dropId
        `,
        { ...input, viewerProfileIds },
        this.connectionOptions(connection)
      )
    ]);
    const blockers = new Set(blockRows.map((row) => row.blocker_profile_id));
    const hiders = new Set(hiddenRows.map((row) => row.profile_id));
    return viewerProfileIds.reduce<Record<string, DropViewerModerationContext>>(
      (acc, profileId) => {
        acc[profileId] = {
          author_blocked: blockers.has(profileId),
          drop_hidden: hiders.has(profileId)
        };
        return acc;
      },
      {}
    );
  }

  async filterUnavailableDropNotificationRows<
    T extends {
      readonly related_drop_id: string | null;
      readonly related_drop_2_id: string | null;
    }
  >(notifications: T[], connection?: ConnectionWrapper<any>): Promise<T[]> {
    const dropIds = Array.from(
      new Set(
        notifications
          .flatMap((row) => [row.related_drop_id, row.related_drop_2_id])
          .filter((id): id is string => id !== null)
      )
    );
    if (!dropIds.length) {
      return notifications;
    }
    const rows = await this.db.execute<{ drop_id: string }>(
      `
        select drop_id
        from ${CONTENT_MODERATION_DROP_STATES_TABLE}
        where drop_id in (:dropIds)
          and status <> '${DropModerationStatus.VISIBLE}'
      `,
      { dropIds },
      this.connectionOptions(connection)
    );
    const unavailable = new Set(rows.map((row) => row.drop_id));
    return notifications.filter(
      (row) =>
        !unavailable.has(row.related_drop_id ?? '') &&
        !unavailable.has(row.related_drop_2_id ?? '')
    );
  }

  async createReport(
    input: {
      dropId: string;
      reporterProfileId: string;
      authorProfileId: string;
      reason: ContentReportReason;
      notes: string | null;
      contentSnapshot: Record<string, unknown>;
    },
    ctx: RequestContext
  ): Promise<ModerationReportRow> {
    const id = randomUUID();
    const now = Time.currentMillis();
    await this.db.execute(
      `
        insert into ${CONTENT_MODERATION_REPORTS_TABLE} (
          id,
          drop_id,
          reporter_profile_id,
          author_profile_id,
          reason,
          notes,
          content_snapshot,
          status,
          created_at
        ) values (
          :id,
          :dropId,
          :reporterProfileId,
          :authorProfileId,
          :reason,
          :notes,
          cast(:contentSnapshot as json),
          :status,
          :createdAt
        )
      `,
      {
        ...input,
        id,
        contentSnapshot: JSON.stringify(input.contentSnapshot),
        status: ContentReportStatus.OPEN,
        createdAt: now
      },
      this.connectionOptions(ctx.connection)
    );
    await this.insertAudit(
      {
        actorProfileId: input.reporterProfileId,
        action: 'CONTENT_REPORTED',
        targetDropId: input.dropId,
        targetProfileId: input.authorProfileId,
        newState: ContentReportStatus.OPEN,
        reason: input.reason,
        metadata: { report_id: id }
      },
      ctx.connection
    );
    return {
      id,
      drop_id: input.dropId,
      reporter_profile_id: input.reporterProfileId,
      author_profile_id: input.authorProfileId,
      reason: input.reason,
      notes: input.notes,
      content_snapshot: input.contentSnapshot,
      status: ContentReportStatus.OPEN,
      ai_recommendation: null,
      ai_category: null,
      ai_confidence: null,
      ai_rationale: null,
      ai_evidence: null,
      ai_policy_version: null,
      ai_assessed_at: null,
      created_at: now,
      resolved_by_profile_id: null,
      resolution_reason: null,
      resolved_at: null
    };
  }

  async createReportWithViewerActions(
    input: {
      readonly dropId: string;
      readonly reporterProfileId: string;
      readonly authorProfileId: string;
      readonly reason: ContentReportReason;
      readonly notes: string | null;
      readonly contentSnapshot: Record<string, unknown>;
      readonly hideDrop: boolean;
      readonly blockAuthor: boolean;
    },
    ctx: RequestContext
  ): Promise<ModerationReportRow> {
    return this.withTransaction(ctx.connection, async (connection) => {
      const transactionContext: RequestContext = { ...ctx, connection };
      await this.assertReportAllowed(input, connection);
      const report = await this.createReport(input, transactionContext);
      if (input.blockAuthor) {
        await this.blockProfile(
          input.reporterProfileId,
          input.authorProfileId,
          transactionContext
        );
      }
      if (input.hideDrop) {
        await this.hideDrop(
          input.reporterProfileId,
          input.dropId,
          transactionContext
        );
      }
      return report;
    });
  }

  async saveReportAssessment(
    reportId: string,
    assessment: AiModerationAssessment,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const assessedAt = Time.currentMillis();
    await this.db.execute(
      `
        update ${CONTENT_MODERATION_REPORTS_TABLE}
        set ai_recommendation = :recommendation,
            ai_category = :category,
            ai_confidence = :confidence,
            ai_rationale = :rationale,
            ai_evidence = cast(:evidence as json),
            ai_policy_version = :policyVersion,
            ai_assessed_at = :assessedAt
        where id = :reportId
      `,
      {
        reportId,
        ...assessment,
        evidence: JSON.stringify(assessment.evidence),
        assessedAt
      },
      this.connectionOptions(connection)
    );
  }

  async getModerationQueue(
    { limit, before }: { limit: number; before?: string | null },
    connection?: ConnectionWrapper<any>
  ): Promise<
    Array<ModerationReportRow & { report_count: number; cursor: string }>
  > {
    const cursor = before ? this.decodeModerationQueueCursor(before) : null;
    const recommendationRankSql = `
      case r.ai_recommendation
        when '${ContentModerationRecommendation.URGENT_QUARANTINE}' then 0
        when '${ContentModerationRecommendation.NEEDS_HUMAN_REVIEW}' then 1
        else 2
      end
    `;
    const rows = await this.db.execute<ModerationQueueReportRow>(
      `
        select
          r.*,
          counts.report_count,
          ${recommendationRankSql} as recommendation_rank
        from ${CONTENT_MODERATION_REPORTS_TABLE} r
        join (
          select drop_id, count(*) as report_count
          from ${CONTENT_MODERATION_REPORTS_TABLE}
          where status = '${ContentReportStatus.OPEN}'
          group by drop_id
        ) counts on counts.drop_id = r.drop_id
        where r.status = '${ContentReportStatus.OPEN}'
          and (
            :beforeRank is null
            or ${recommendationRankSql} > :beforeRank
            or (
              ${recommendationRankSql} = :beforeRank
              and r.created_at < :beforeCreatedAt
            )
            or (
              ${recommendationRankSql} = :beforeRank
              and r.created_at = :beforeCreatedAt
              and r.id < :beforeReportId
            )
          )
        order by
          recommendation_rank,
          r.created_at desc,
          r.id desc
        limit :limit
      `,
      {
        limit,
        beforeRank: cursor?.recommendationRank ?? null,
        beforeCreatedAt: cursor?.createdAt ?? null,
        beforeReportId: cursor?.reportId ?? null
      },
      this.connectionOptions(connection)
    );
    return rows.map((row) => {
      const parsed = this.parseReportJson(row);
      const { recommendation_rank: recommendationRank, ...report } = parsed;
      return {
        ...report,
        cursor: this.encodeModerationQueueCursor({
          recommendationRank,
          createdAt: report.created_at,
          reportId: report.id
        })
      };
    });
  }

  async getAuditHistoryForDrops(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, Array<Record<string, unknown>>>> {
    if (!dropIds.length) {
      return {};
    }
    const rows = await this.db.execute<
      Record<string, unknown> & { target_drop_id: string }
    >(
      `
        select *
        from ${CONTENT_MODERATION_AUDIT_LOG_TABLE}
        where target_drop_id in (:dropIds)
        order by created_at asc, id asc
      `,
      { dropIds: Array.from(new Set(dropIds)) },
      this.connectionOptions(connection)
    );
    return rows.reduce<Record<string, Array<Record<string, unknown>>>>(
      (acc, row) => {
        const history = acc[row.target_drop_id] ?? [];
        history.push(row);
        acc[row.target_drop_id] = history;
        return acc;
      },
      {}
    );
  }

  async tryAiQuarantineForOpenReport(
    input: {
      reportId: string;
      dropId: string;
      reason: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    return this.withTransaction(ctx.connection, async (connection) => {
      const current = await this.ensureAndLockDropState(
        input.dropId,
        connection
      );
      const report = await this.db.oneOrNull<{ status: ContentReportStatus }>(
        `
          select status
          from ${CONTENT_MODERATION_REPORTS_TABLE}
          where id = :reportId
          for update
        `,
        { reportId: input.reportId },
        this.connectionOptions(connection)
      );
      if (
        report?.status !== ContentReportStatus.OPEN ||
        current !== DropModerationStatus.VISIBLE
      ) {
        return false;
      }
      await this.writeDropModerationStatus(
        {
          dropId: input.dropId,
          status: DropModerationStatus.AI_QUARANTINED,
          actorProfileId: null,
          reason: input.reason,
          action: 'AI_QUARANTINED',
          previousStatus: current
        },
        connection
      );
      return true;
    });
  }

  async applyModeratorDropDecision(
    input: {
      dropId: string;
      status: DropModerationStatus;
      actorProfileId: string;
      reason: string;
      action: string;
      reportStatus: ContentReportStatus | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.withTransaction(ctx.connection, async (connection) => {
      const current = await this.ensureAndLockDropState(
        input.dropId,
        connection
      );
      await this.writeDropModerationStatus(
        { ...input, previousStatus: current },
        connection
      );
      if (input.reportStatus !== null) {
        await this.resolveOpenReportsForDrop(
          {
            dropId: input.dropId,
            status: input.reportStatus,
            moderatorProfileId: input.actorProfileId,
            reason: input.reason
          },
          connection
        );
      }
    });
  }

  private async ensureAndLockDropState(
    dropId: string,
    connection: ConnectionWrapper<any>
  ): Promise<DropModerationStatus> {
    await this.assertDropExists(dropId, connection, true);
    await this.db.execute(
      `
        insert into ${CONTENT_MODERATION_DROP_STATES_TABLE} (
          drop_id,
          status,
          updated_by_profile_id,
          reason,
          updated_at
        ) values (
          :dropId,
          '${DropModerationStatus.VISIBLE}',
          null,
          null,
          :updatedAt
        )
        on duplicate key update drop_id = values(drop_id)
      `,
      { dropId, updatedAt: Time.currentMillis() },
      this.connectionOptions(connection)
    );
    return this.getLockedDropStatus(dropId, connection);
  }

  private async getLockedDropStatus(
    dropId: string,
    connection: ConnectionWrapper<any>
  ): Promise<DropModerationStatus> {
    const current = await this.db.oneOrNull<{ status: DropModerationStatus }>(
      `
        select status
        from ${CONTENT_MODERATION_DROP_STATES_TABLE}
        where drop_id = :dropId
        for update
      `,
      { dropId },
      this.connectionOptions(connection)
    );
    return current?.status ?? DropModerationStatus.VISIBLE;
  }

  private async writeDropModerationStatus(
    input: {
      dropId: string;
      status: DropModerationStatus;
      actorProfileId: string | null;
      reason: string;
      action: string;
      previousStatus: DropModerationStatus;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        insert into ${CONTENT_MODERATION_DROP_STATES_TABLE} (
          drop_id,
          status,
          updated_by_profile_id,
          reason,
          updated_at
        ) values (
          :dropId,
          :status,
          :actorProfileId,
          :reason,
          :updatedAt
        )
        on duplicate key update
          status = values(status),
          updated_by_profile_id = values(updated_by_profile_id),
          reason = values(reason),
          updated_at = values(updated_at)
      `,
      { ...input, updatedAt: Time.currentMillis() },
      this.connectionOptions(connection)
    );
    await this.insertAudit(
      {
        actorProfileId: input.actorProfileId,
        action: input.action,
        targetDropId: input.dropId,
        previousState: input.previousStatus,
        newState: input.status,
        reason: input.reason
      },
      connection
    );
  }

  async resolveOpenReportsForDrop(
    input: {
      dropId: string;
      status: ContentReportStatus;
      moderatorProfileId: string;
      reason: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        update ${CONTENT_MODERATION_REPORTS_TABLE}
        set status = :status,
            resolved_by_profile_id = :moderatorProfileId,
            resolution_reason = :reason,
            resolved_at = :resolvedAt
        where drop_id = :dropId
          and status = '${ContentReportStatus.OPEN}'
      `,
      { ...input, resolvedAt: Time.currentMillis() },
      this.connectionOptions(connection)
    );
  }

  async setProfileStatus(
    input: {
      profileId: string;
      status: ModeratedProfileStatus;
      moderatorProfileId: string;
      reason: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.withTransaction(ctx.connection, async (connection) => {
      await this.assertProfileExists(input.profileId, connection);
      const previous = await this.getProfileStatus(input.profileId, connection);
      await this.db.execute(
        `
        insert into ${CONTENT_MODERATION_PROFILE_STATES_TABLE} (
          profile_id,
          status,
          updated_by_profile_id,
          reason,
          updated_at
        ) values (
          :profileId,
          :status,
          :moderatorProfileId,
          :reason,
          :updatedAt
        )
        on duplicate key update
          status = values(status),
          updated_by_profile_id = values(updated_by_profile_id),
          reason = values(reason),
          updated_at = values(updated_at)
      `,
        { ...input, updatedAt: Time.currentMillis() },
        this.connectionOptions(connection)
      );
      await this.insertAudit(
        {
          actorProfileId: input.moderatorProfileId,
          action:
            input.status === ModeratedProfileStatus.SUSPENDED
              ? 'PROFILE_SUSPENDED'
              : 'PROFILE_REINSTATED',
          targetProfileId: input.profileId,
          previousState: previous,
          newState: input.status,
          reason: input.reason
        },
        connection
      );
    });
  }

  async getProfileStatus(
    profileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<ModeratedProfileStatus> {
    const row = await this.db.oneOrNull<{ status: ModeratedProfileStatus }>(
      `
        select status
        from ${CONTENT_MODERATION_PROFILE_STATES_TABLE}
        where profile_id = :profileId
      `,
      { profileId },
      this.connectionOptions(connection)
    );
    return row?.status ?? ModeratedProfileStatus.ACTIVE;
  }

  async isModerator(
    profileId: string,
    seedProfileIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<boolean> {
    if (seedProfileIds.includes(profileId)) {
      return true;
    }
    return (
      (await this.db.oneOrNull<{ profile_id: string }>(
        `
          select profile_id
          from ${CONTENT_MODERATION_ROLES_TABLE}
          where profile_id = :profileId
        `,
        { profileId },
        this.connectionOptions(connection)
      )) !== null
    );
  }

  async countRecentMatchingDrops(
    input: {
      authorProfileId: string;
      contentFingerprint: string;
      since: number;
      excludeDropId: string | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ match_count: number }>(
      `
        select count(*) as match_count
        from ${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}
        where author_profile_id = :authorProfileId
          and created_at >= :since
          and content_fingerprint = :contentFingerprint
          and (:excludeDropId is null or drop_id <> :excludeDropId)
      `,
      input,
      this.connectionOptions(connection)
    );
    return Number(row?.match_count ?? 0);
  }

  async recordPrePublicationCheck(
    input: PrePublicationCheckRecord,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        insert into ${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE} (
          id,
          drop_id,
          author_profile_id,
          operation,
          deterministic_gate_version,
          content_fingerprint,
          signal,
          outcome,
          evaluator_version,
          evaluator_result,
          created_at
        ) values (
          :id,
          :dropId,
          :authorProfileId,
          :operation,
          :deterministicGateVersion,
          :contentFingerprint,
          :signal,
          :outcome,
          :evaluatorVersion,
          cast(:evaluatorResult as json),
          :createdAt
        )
      `,
      {
        id: randomUUID(),
        ...input,
        evaluatorResult: input.evaluatorResult
          ? JSON.stringify(input.evaluatorResult)
          : null,
        createdAt: Time.currentMillis()
      },
      this.connectionOptions(connection)
    );
  }

  async deleteExpiredPrePublicationChecks(
    olderThan: number,
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    const result = await this.db.execute(
      `
        delete from ${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}
        where created_at < :olderThan
      `,
      { olderThan },
      this.connectionOptions(connection)
    );
    if (result && typeof result === 'object' && 'affectedRows' in result) {
      return Number((result as { affectedRows?: unknown }).affectedRows ?? 0);
    }
    return Array.isArray(result) && typeof result[1] === 'number'
      ? result[1]
      : 0;
  }

  private async assertReportAllowed(
    input: {
      readonly dropId: string;
      readonly reporterProfileId: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const reporter = await this.db.oneOrNull<{ external_id: string }>(
      `
        select external_id
        from ${PROFILES_TABLE}
        where external_id = :reporterProfileId
        for update
      `,
      { reporterProfileId: input.reporterProfileId },
      this.connectionOptions(connection)
    );
    if (!reporter) {
      throw new NotFoundException(
        `Profile ${input.reporterProfileId} not found`
      );
    }
    const existing = await this.db.oneOrNull<{ id: string }>(
      `
        select id
        from ${CONTENT_MODERATION_REPORTS_TABLE}
        where reporter_profile_id = :reporterProfileId
          and drop_id = :dropId
          and status = '${ContentReportStatus.OPEN}'
        limit 1
      `,
      input,
      this.connectionOptions(connection)
    );
    if (existing) {
      throw new BadRequestException('You have already reported this post');
    }
    const configuredLimit =
      env.getIntOrNull('CONTENT_MODERATION_REPORTS_PER_HOUR') ??
      DEFAULT_REPORTS_PER_HOUR;
    const reportsPerHour = Math.max(1, configuredLimit);
    const recent = await this.db.oneOrNull<{ report_count: number }>(
      `
        select count(*) as report_count
        from ${CONTENT_MODERATION_REPORTS_TABLE}
        where reporter_profile_id = :reporterProfileId
          and created_at >= :since
      `,
      {
        reporterProfileId: input.reporterProfileId,
        since: Time.currentMillis() - REPORT_RATE_LIMIT_WINDOW.toMillis()
      },
      this.connectionOptions(connection)
    );
    if (Number(recent?.report_count ?? 0) >= reportsPerHour) {
      throw new BadRequestException(
        'Too many reports were submitted. Please try again later.'
      );
    }
  }

  private async assertDropExists(
    dropId: string,
    connection?: ConnectionWrapper<any>,
    lockForUpdate = false
  ): Promise<void> {
    const row = await this.db.oneOrNull<{ id: string }>(
      `
        select id
        from ${DROPS_TABLE}
        where id = :dropId
        ${lockForUpdate ? 'for update' : ''}
      `,
      { dropId },
      this.connectionOptions(connection)
    );
    if (!row) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
  }

  private async assertProfileExists(
    profileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    const row = await this.db.oneOrNull<{ external_id: string }>(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId`,
      { profileId },
      this.connectionOptions(connection)
    );
    if (!row) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
  }

  async getDropSnapshot(
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<{
    drop_id: string;
    author_profile_id: string;
    wave_id: string;
    title: string | null;
    parts: Array<{
      part_no: number;
      content: string | null;
      media: Array<{
        url: string;
        mime_type: string;
        media_upload_id: string | null;
      }>;
      attachments: Array<{
        id: string;
        original_file_name: string;
        kind: string;
        declared_mime: string;
        detected_mime: string | null;
        status: string;
        size_bytes: number | null;
        sha256: string | null;
        verdict: string | null;
        ipfs_url: string | null;
      }>;
    }>;
    reply_to_drop_id: string | null;
  }> {
    const drop = await this.db.oneOrNull<{
      id: string;
      author_id: string;
      wave_id: string;
      title: string | null;
      reply_to_drop_id: string | null;
    }>(
      `
        select id, author_id, wave_id, title, reply_to_drop_id
        from ${DROPS_TABLE}
        where id = :dropId
      `,
      { dropId },
      this.connectionOptions(connection)
    );
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const [parts, media, attachments] = await Promise.all([
      this.db.execute<{
        drop_part_id: number;
        content: string | null;
      }>(
        `
          select drop_part_id, content
          from ${DROPS_PARTS_TABLE}
          where drop_id = :dropId
          order by drop_part_id asc
        `,
        { dropId },
        this.connectionOptions(connection)
      ),
      this.db.execute<{
        drop_part_id: number;
        url: string;
        mime_type: string;
        media_upload_id: string | null;
      }>(
        `
          select drop_part_id, url, mime_type, media_upload_id
          from ${DROP_MEDIA_TABLE}
          where drop_id = :dropId
          order by id asc
        `,
        { dropId },
        this.connectionOptions(connection)
      ),
      this.db.execute<{
        drop_part_id: number;
        id: string;
        original_file_name: string;
        kind: string;
        declared_mime: string;
        detected_mime: string | null;
        status: string;
        size_bytes: number | null;
        sha256: string | null;
        verdict: string | null;
        ipfs_url: string | null;
      }>(
        `
          select
            da.drop_part_id,
            a.id,
            a.original_file_name,
            a.kind,
            a.declared_mime,
            a.detected_mime,
            a.status,
            a.size_bytes,
            a.sha256,
            a.verdict,
            a.ipfs_url
          from ${DROP_ATTACHMENTS_TABLE} da
          join ${ATTACHMENTS_TABLE} a on a.id = da.attachment_id
          where da.drop_id = :dropId
          order by da.drop_part_id asc, a.id asc
        `,
        { dropId },
        this.connectionOptions(connection)
      )
    ]);
    return {
      drop_id: drop.id,
      author_profile_id: drop.author_id,
      wave_id: drop.wave_id,
      title: drop.title,
      parts: parts.map((part) => ({
        part_no: Number(part.drop_part_id),
        content: part.content,
        media: media
          .filter(
            (item) => Number(item.drop_part_id) === Number(part.drop_part_id)
          )
          .map((item) => ({
            url: item.url,
            mime_type: item.mime_type,
            media_upload_id: item.media_upload_id
          })),
        attachments: attachments
          .filter(
            (item) => Number(item.drop_part_id) === Number(part.drop_part_id)
          )
          .map((item) => ({
            id: item.id,
            original_file_name: item.original_file_name,
            kind: item.kind,
            declared_mime: item.declared_mime,
            detected_mime: item.detected_mime,
            status: item.status,
            size_bytes:
              item.size_bytes === null ? null : Number(item.size_bytes),
            sha256: item.sha256,
            verdict: item.verdict,
            ipfs_url: item.ipfs_url
          }))
      })),
      reply_to_drop_id: drop.reply_to_drop_id
    };
  }

  private async insertAudit(
    input: {
      actorProfileId: string | null;
      action: string;
      targetDropId?: string | null;
      targetProfileId?: string | null;
      previousState?: string | null;
      newState?: string | null;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        insert into ${CONTENT_MODERATION_AUDIT_LOG_TABLE} (
          created_at,
          actor_profile_id,
          action,
          target_drop_id,
          target_profile_id,
          previous_state,
          new_state,
          reason,
          metadata
        ) values (
          :createdAt,
          :actorProfileId,
          :action,
          :targetDropId,
          :targetProfileId,
          :previousState,
          :newState,
          :reason,
          cast(:metadata as json)
        )
      `,
      {
        createdAt: Time.currentMillis(),
        actorProfileId: input.actorProfileId,
        action: input.action,
        targetDropId: input.targetDropId ?? null,
        targetProfileId: input.targetProfileId ?? null,
        previousState: input.previousState ?? null,
        newState: input.newState ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null
      },
      this.connectionOptions(connection)
    );
  }

  private parseReportJson<T extends ModerationReportRow>(row: T): T {
    const parse = <V>(value: V | string): V => {
      if (typeof value === 'string') {
        return JSON.parse(value) as V;
      }
      return value;
    };
    return {
      ...row,
      content_snapshot: parse(row.content_snapshot),
      ai_evidence: row.ai_evidence === null ? null : parse(row.ai_evidence),
      ai_confidence:
        row.ai_confidence === null ? null : Number(row.ai_confidence)
    };
  }

  private encodeModerationQueueCursor(cursor: ModerationQueueCursor): string {
    return `${cursor.recommendationRank}.${cursor.createdAt}.${cursor.reportId}`;
  }

  private decodeModerationQueueCursor(value: string): ModerationQueueCursor {
    const match =
      /^([0-2])\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
        value
      );
    const recommendationRank = Number(match?.[1]);
    const createdAt = Number(match?.[2]);
    const reportId = match?.[3];
    if (
      !match ||
      !Number.isSafeInteger(recommendationRank) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !reportId
    ) {
      throw new BadRequestException('Invalid moderation queue cursor');
    }
    return { recommendationRank, createdAt, reportId };
  }

  private connectionOptions(connection?: ConnectionWrapper<any>) {
    return connection ? { wrappedConnection: connection } : undefined;
  }

  private async withTransaction<T>(
    connection: ConnectionWrapper<any> | undefined,
    executable: (connection: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    return connection
      ? executable(connection)
      : this.executeNativeQueriesInTransaction(executable);
  }
}

export const contentModerationDb = new ContentModerationDb(dbSupplier);
