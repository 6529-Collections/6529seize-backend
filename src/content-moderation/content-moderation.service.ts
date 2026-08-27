import { env } from '@/env';
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  ModeratedProfileStatus
} from '@/entities/IContentModeration';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  contentModerationAiService,
  ContentModerationAiService,
  CONTENT_MODERATION_POLICY_VERSION
} from './content-moderation-ai.service';
import {
  contentModerationDb,
  ContentModerationDb,
  ModerationReportsView,
  ModerationReportRow
} from './content-moderation.db';

export interface SubmitContentReportInput {
  readonly dropId: string;
  readonly reporterProfileId: string;
  readonly reason: ContentReportReason;
  readonly notes: string | null;
  readonly hideDrop: boolean;
  readonly blockAuthor: boolean;
}

type DropModerationDecision = 'ALLOW' | 'QUARANTINE' | 'REMOVE';

type ContentModerationDbDependency = Pick<
  ContentModerationDb,
  | 'applyModeratorDropDecision'
  | 'createReportWithViewerActions'
  | 'getAuditHistoryForDrops'
  | 'getDropSnapshot'
  | 'getExistingProfileStatus'
  | 'getModerationCounts'
  | 'getModerationQueue'
  | 'getReportsForProfile'
  | 'getPresentations'
  | 'getSuspendedProfiles'
  | 'isModerator'
  | 'saveReportAssessment'
  | 'setProfileStatus'
  | 'tryAiQuarantineForOpenReport'
  | 'withdrawOpenReport'
>;

type ContentModerationAiDependency = Pick<
  ContentModerationAiService,
  'assessReportedContent'
>;

export class ContentModerationService {
  private readonly logger = Logger.get(ContentModerationService.name);

  constructor(
    private readonly db: ContentModerationDbDependency,
    private readonly aiService: ContentModerationAiDependency
  ) {}

  async submitReport(
    input: SubmitContentReportInput,
    ctx: RequestContext
  ): Promise<{
    id: string;
    status: ContentReportStatus;
    drop_status: DropModerationStatus;
  }> {
    const snapshot = await this.db.getDropSnapshot(
      input.dropId,
      ctx.connection
    );
    if (snapshot.author_profile_id === input.reporterProfileId) {
      throw new BadRequestException(`You can't report your own post`);
    }
    const parentContext = await this.getParentContext(snapshot, ctx);
    const contentSnapshot = {
      ...snapshot,
      parent_context: parentContext
    };

    // Commit the allegation, private evidence, and requested personal actions
    // together before any external classifier call.
    const report = await this.db.createReportWithViewerActions(
      {
        dropId: input.dropId,
        reporterProfileId: input.reporterProfileId,
        authorProfileId: snapshot.author_profile_id,
        reason: input.reason,
        notes: input.notes,
        contentSnapshot,
        hideDrop: input.hideDrop,
        blockAuthor: input.blockAuthor
      },
      ctx
    );

    const assessment = await this.assessReport(report, snapshot, parentContext);
    await this.db.saveReportAssessment(report.id, assessment, ctx.connection);
    if (
      assessment.recommendation ===
        ContentModerationRecommendation.URGENT_QUARANTINE &&
      assessment.confidence >= 0.95
    ) {
      await this.db.tryAiQuarantineForOpenReport(
        {
          reportId: report.id,
          dropId: input.dropId,
          reason: assessment.rationale
        },
        ctx
      );
    }
    const currentPresentation = await this.db.getPresentations(
      [{ id: input.dropId, author_id: snapshot.author_profile_id }],
      null,
      ctx.connection
    );
    const dropStatus =
      currentPresentation[input.dropId]?.moderation.status ??
      DropModerationStatus.VISIBLE;
    return {
      id: report.id,
      status: ContentReportStatus.OPEN,
      drop_status: dropStatus
    };
  }

  async getModeratorAccess(profileId: string, ctx: RequestContext) {
    const moderator = await this.db.isModerator(
      profileId,
      this.getConfiguredModeratorProfileIds(),
      ctx.connection
    );
    if (!moderator) {
      return {
        moderator: false,
        has_open_reports: false,
        open_report_count: 0,
        resolved_report_count: 0,
        suspended_profile_count: 0
      };
    }
    const counts = await this.db.getModerationCounts(ctx.connection);
    return {
      moderator: true,
      has_open_reports: counts.open_report_count > 0,
      ...counts
    };
  }

  async getQueue(
    profileId: string,
    input: {
      limit: number;
      before?: string | null;
      view?: ModerationReportsView;
    },
    ctx: RequestContext
  ) {
    await this.assertModerator(profileId, ctx);
    const reports = await this.db.getModerationQueue(input, ctx.connection);
    const dropIds = Array.from(
      new Set(reports.map((report) => report.drop_id))
    );
    const dropAuthors = reports.map((report) => ({
      id: report.drop_id,
      author_id: report.author_profile_id
    }));
    const [presentations, history] = await Promise.all([
      this.db.getPresentations(dropAuthors, null, ctx.connection),
      this.db.getAuditHistoryForDrops(dropIds, ctx.connection)
    ]);
    return reports.map((report) => ({
      ...report,
      moderation: presentations[report.drop_id]?.moderation ?? {
        status: DropModerationStatus.VISIBLE,
        can_view: true
      },
      history: history[report.drop_id] ?? []
    }));
  }

  async getReportsForProfile(
    profileId: string,
    input: { limit: number; before?: string | null },
    ctx: RequestContext
  ) {
    return this.db.getReportsForProfile(profileId, input, ctx.connection);
  }

  async getSuspendedProfiles(
    moderatorProfileId: string,
    input: { limit: number; before?: string | null },
    ctx: RequestContext
  ) {
    await this.assertModerator(moderatorProfileId, ctx);
    return this.db.getSuspendedProfiles(input, ctx.connection);
  }

  async getPublicProfileStatus(
    profileId: string,
    ctx: RequestContext
  ): Promise<{ profile_id: string; status: ModeratedProfileStatus }> {
    const status = await this.db.getExistingProfileStatus(
      profileId,
      ctx.connection
    );
    return { profile_id: profileId, status };
  }

  async withdrawReport(
    reporterProfileId: string,
    dropId: string,
    ctx: RequestContext
  ) {
    const status = await this.db.withdrawOpenReport(
      reporterProfileId,
      dropId,
      ctx
    );
    return {
      drop_id: dropId,
      status: ContentReportStatus.WITHDRAWN,
      drop_status: status
    };
  }

  async decideDrop(
    moderatorProfileId: string,
    input: {
      dropId: string;
      decision: DropModerationDecision;
      reason: string | null;
    },
    ctx: RequestContext
  ) {
    await this.assertModerator(moderatorProfileId, ctx);
    const target = this.getDropDecisionStatus(input.decision);
    await this.db.applyModeratorDropDecision(
      {
        dropId: input.dropId,
        status: target,
        actorProfileId: moderatorProfileId,
        action: this.getDropDecisionAction(input.decision),
        reason: input.reason,
        reportStatus: this.getResolvedReportStatus(input.decision)
      },
      ctx
    );
    return { drop_id: input.dropId, status: target };
  }

  async setProfileStatus(
    moderatorProfileId: string,
    input: {
      profileId: string;
      status: ModeratedProfileStatus;
      reason: string | null;
    },
    ctx: RequestContext
  ) {
    await this.assertModerator(moderatorProfileId, ctx);
    if (moderatorProfileId === input.profileId) {
      throw new BadRequestException(
        `Moderators can't change their own moderation status`
      );
    }
    await this.db.setProfileStatus(
      {
        profileId: input.profileId,
        status: input.status,
        moderatorProfileId,
        reason: input.reason
      },
      ctx
    );
    return { profile_id: input.profileId, status: input.status };
  }

  private async assessReport(
    report: ModerationReportRow,
    snapshot: Record<string, unknown>,
    parentContext: Record<string, unknown> | null
  ) {
    try {
      const assessment = await this.aiService.assessReportedContent({
        reason: report.reason,
        content: snapshot,
        parentContext
      });
      return {
        ...assessment,
        policyVersion: CONTENT_MODERATION_POLICY_VERSION
      };
    } catch (error) {
      this.logger.error(
        `Reported-content evaluator failed for report ${report.id}`,
        error
      );
      return {
        recommendation: ContentModerationRecommendation.NEEDS_HUMAN_REVIEW,
        category: 'CLASSIFIER_UNAVAILABLE',
        confidence: 0,
        rationale:
          'Automated assessment was unavailable; human review is required.',
        evidence: [],
        policyVersion: CONTENT_MODERATION_POLICY_VERSION
      };
    }
  }

  private async getParentContext(
    snapshot: Record<string, unknown> & { reply_to_drop_id?: unknown },
    ctx: RequestContext
  ): Promise<Record<string, unknown> | null> {
    if (typeof snapshot.reply_to_drop_id === 'string') {
      try {
        return await this.db.getDropSnapshot(
          snapshot.reply_to_drop_id,
          ctx.connection
        );
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }
    }
    return null;
  }

  private async assertModerator(profileId: string, ctx: RequestContext) {
    const isModerator = await this.db.isModerator(
      profileId,
      this.getConfiguredModeratorProfileIds(),
      ctx.connection
    );
    if (!isModerator) {
      throw new ForbiddenException('Moderator access is required');
    }
  }

  private getDropDecisionStatus(
    decision: DropModerationDecision
  ): DropModerationStatus {
    if (decision === 'ALLOW') {
      return DropModerationStatus.VISIBLE;
    }
    if (decision === 'QUARANTINE') {
      return DropModerationStatus.AI_QUARANTINED;
    }
    return DropModerationStatus.MODERATOR_REMOVED;
  }

  private getDropDecisionAction(decision: DropModerationDecision): string {
    if (decision === 'ALLOW') {
      return 'MODERATOR_ALLOWED_OR_RESTORED';
    }
    if (decision === 'QUARANTINE') {
      return 'MODERATOR_QUARANTINED';
    }
    return 'MODERATOR_REMOVED';
  }

  private getResolvedReportStatus(
    decision: DropModerationDecision
  ): ContentReportStatus | null {
    if (decision === 'QUARANTINE') {
      return null;
    }
    return decision === 'ALLOW'
      ? ContentReportStatus.RESOLVED_ALLOWED
      : ContentReportStatus.RESOLVED_REMOVED;
  }

  private getConfiguredModeratorProfileIds(): string[] {
    return Array.from(
      new Set(
        [
          ...env.getStringArray('DEVS_6529_MENTION_PROFILE_IDS', ','),
          ...env.getStringArray('CONTENT_MODERATOR_PROFILE_IDS', ',')
        ]
          .map((id) => id.trim())
          .filter(Boolean)
      )
    );
  }
}

export const contentModerationService = new ContentModerationService(
  contentModerationDb,
  contentModerationAiService
);
