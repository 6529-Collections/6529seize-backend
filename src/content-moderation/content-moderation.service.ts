import { isModerationDeveloper } from './moderation-developer-access';
import { moderationReviewDb, ModerationReviewDb } from './moderation-review.db';
import {
  moderationFingerprint,
  ModerationInput
} from './moderation-review.types';
import {
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID,
  getConfiguredBedrockAnthropicModelId
} from '@/bedrock.config';
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
  | 'getBlockActivity'
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
    private readonly aiService: ContentModerationAiDependency,
    private readonly reviews: ModerationReviewDb = moderationReviewDb
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

    const snapshotParts = Array.isArray(snapshot.parts)
      ? (snapshot.parts as Array<{ content?: string | null }>)
      : [];
    const revision = moderationFingerprint({
      title: snapshot.title ?? null,
      parts: snapshotParts.map((part) => ({ content: part.content ?? null }))
    });
    const reviewInput: ModerationInput = {
      subject_type: 'DROP',
      subject_id: input.dropId,
      author_profile_id: snapshot.author_profile_id,
      actor_profile_id: input.reporterProfileId,
      operation: 'REPORT',
      policy_family: 'WAVE_CONTENT',
      policy_version: CONTENT_MODERATION_POLICY_VERSION,
      scope: {
        report_id: report.id,
        report_reason: input.reason,
        wave_id: snapshot.wave_id ?? null,
        current_revision: revision
      },
      evidence: contentSnapshot
    };
    const review = await this.reviews.start(reviewInput, 'CONTENT_REPORTED', {
      ...ctx,
      connection: undefined
    });
    await this.reviews.bindReport(report.id, review.item.id, {
      ...ctx,
      connection: undefined
    });
    await this.reviews.attachPublication(
      review.item.id,
      input.dropId,
      revision,
      { ...ctx, connection: undefined }
    );
    const assessment = await this.assessReport(report, snapshot, parentContext);
    await this.reviews.finish(review.evaluationId, {
      outcome:
        assessment.category === 'CLASSIFIER_UNAVAILABLE'
          ? 'ERROR'
          : assessment.recommendation ===
              ContentModerationRecommendation.NO_VIOLATION_DETECTED
            ? 'ALLOW'
            : 'REJECT',
      result: {
        ...assessment,
        report: { id: report.id, reason: input.reason, notes: input.notes }
      },
      model: getConfiguredBedrockAnthropicModelId(
        'CONTENT_MODERATION_BEDROCK_MODEL_ID',
        DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
      ),
      fallback:
        assessment.category === 'CLASSIFIER_UNAVAILABLE' ? 'HUMAN_REVIEW' : null
    });
    await this.db.saveReportAssessment(report.id, assessment, ctx.connection);
    if (
      assessment.recommendation ===
        ContentModerationRecommendation.URGENT_QUARANTINE &&
      assessment.confidence >= 0.95
    ) {
      await this.reviews.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          await this.reviews.lockSubject(
            { ...review.item, published_subject_id: input.dropId },
            tx
          );
          const latestReview = await this.reviews.get(review.item.id, tx, true);
          if (
            latestReview.override ||
            latestReview.version !== review.item.version + 1 ||
            (await this.reviews.currentRevision(latestReview, tx)) !== revision
          )
            return;
          const changed = await this.db.tryAiQuarantineForOpenReport(
            {
              reportId: report.id,
              dropId: input.dropId,
              reason: assessment.rationale
            },
            tx
          );
          if (changed) {
            await this.reviews.audit(
              latestReview,
              {
                actor: null,
                action: 'AI_QUARANTINED',
                reason: assessment.rationale,
                evaluationId: review.evaluationId
              },
              tx
            );
            await this.reviews.bumpVersion(latestReview.id, tx);
            await this.reviews.invalidateRelatedVersions(
              latestReview,
              'QUARANTINE',
              tx
            );
          }
        }
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
    const moderator =
      isModerationDeveloper(profileId) &&
      !ctx.authenticationContext?.isAuthenticatedAsProxy();
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

  async getBlockActivity(
    moderatorProfileId: string,
    input: {
      limit: number;
      before?: string | null;
      include_unblocks?: boolean;
    },
    ctx: RequestContext
  ) {
    await this.assertModerator(moderatorProfileId, ctx);
    return this.db.getBlockActivity(input, ctx.connection);
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
    } catch {
      this.logger.error(
        `Reported-content evaluator failed for report ${report.id}`
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
    if (
      !isModerationDeveloper(profileId) ||
      ctx.authenticationContext?.isAuthenticatedAsProxy()
    ) {
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
}

export const contentModerationService = new ContentModerationService(
  contentModerationDb,
  contentModerationAiService
);
