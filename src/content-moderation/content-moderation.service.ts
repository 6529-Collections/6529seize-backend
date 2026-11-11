import { isModerationDeveloper } from './moderation-developer-access';
import {
  moderationReviewDb,
  ModerationReviewDb,
  throwModerationCaptureFailure
} from './moderation-review.db';
import {
  moderationFingerprint,
  ModerationInput,
  reportReviewOutcome
} from './moderation-review.types';
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
  CONTENT_MODERATION_POLICY_VERSION,
  getContentModerationBedrockModelId
} from './content-moderation-ai.service';
import {
  contentModerationDb,
  ContentModerationDb,
  ModerationReportsView,
  ModerationReportRow
} from './content-moderation.db';
import {
  prePublicationModerationService,
  PrePublicationModerationService
} from './pre-publication-moderation.service';
import { env } from '@/env';

export const AUTO_QUARANTINE_MIN_REPORTERS_ENV =
  'CONTENT_MODERATION_AUTO_QUARANTINE_MIN_REPORTERS';
export const AUTO_QUARANTINE_SIGNAL_CORROBORATES_ENV =
  'CONTENT_MODERATION_AUTO_QUARANTINE_SIGNAL_CORROBORATES';
const DEFAULT_AUTO_QUARANTINE_MIN_REPORTERS = 2;

/**
 * An urgent, high-confidence assessment hides a reported drop only when it
 * is corroborated: by at least `minReporters` distinct open reporters
 * (default 2), or by one report plus a deterministic content signal (on by
 * default). `minReporters = 1` restores single-report quarantine.
 */
export interface AutoQuarantineCorroborationRule {
  readonly minReporters: number;
  readonly signalCorroborates: boolean;
}

export function getAutoQuarantineCorroborationRule(): AutoQuarantineCorroborationRule {
  const rawMin = env.getStringOrNull(AUTO_QUARANTINE_MIN_REPORTERS_ENV)?.trim();
  const minReporters = rawMin
    ? Number(rawMin)
    : DEFAULT_AUTO_QUARANTINE_MIN_REPORTERS;
  if (!Number.isInteger(minReporters) || minReporters <= 0) {
    throw new Error(
      `${AUTO_QUARANTINE_MIN_REPORTERS_ENV} must be a positive integer`
    );
  }
  const rawSignal = env
    .getStringOrNull(AUTO_QUARANTINE_SIGNAL_CORROBORATES_ENV)
    ?.trim()
    .toLowerCase();
  return {
    minReporters,
    signalCorroborates: rawSignal !== 'false'
  };
}

function snapshotText(snapshot: Record<string, unknown>): string {
  const parts = Array.isArray(snapshot.parts)
    ? (snapshot.parts as Array<{ content?: string | null }>)
    : [];
  return [
    typeof snapshot.title === 'string' ? snapshot.title : null,
    ...parts.map((part) => part.content ?? null)
  ]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.trim())
    .join('\n');
}

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
  | 'countOpenReportersForDrop'
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
    private readonly reviews: ModerationReviewDb = moderationReviewDb,
    private readonly signalScreen: Pick<
      PrePublicationModerationService,
      'findContentPatternSignal'
    > = prePublicationModerationService
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
    const parentContext = await this.getParentContext(
      snapshot,
      input.reporterProfileId,
      ctx
    );
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
    const review = await this.reviews
      .executeNativeQueriesInTransaction(async (connection) => {
        const tx = { ...ctx, connection };
        // Match first-review materialization: lock the report before its item.
        await this.reviews.reportForReview(report.id, tx, true);
        const started = await this.reviews.start(
          reviewInput,
          'CONTENT_REPORTED',
          tx
        );
        await this.reviews.bindReport(report.id, started.item.id, tx);
        await this.reviews.attachPublication(
          started.item.id,
          input.dropId,
          revision,
          tx
        );
        return started;
      })
      .catch(throwModerationCaptureFailure);
    const assessment = await this.assessReport(report, snapshot, parentContext);
    await this.reviews.finish(review.evaluationId, {
      outcome: reportReviewOutcome(
        assessment.recommendation,
        assessment.category === 'CLASSIFIER_UNAVAILABLE'
      ),
      result: {
        ...assessment,
        report: { id: report.id, reason: input.reason, notes: input.notes }
      },
      model: getContentModerationBedrockModelId(),
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
          if (
            !(await this.isQuarantineCorroborated(input.dropId, snapshot, tx))
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
    const moderator = await isModerationDeveloper(profileId, ctx);
    if (!moderator) {
      return {
        moderator: false,
        needs_review_count: 0,
        has_open_reports: false,
        open_report_count: 0,
        resolved_report_count: 0,
        suspended_profile_count: 0
      };
    }
    const [counts, needsReviewCount] = await Promise.all([
      this.db.getModerationCounts(ctx.connection),
      this.reviews.countReviewCases(ctx)
    ]);
    return {
      moderator: true,
      needs_review_count: needsReviewCount,
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
      case_id?: string;
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

  /**
   * Single-report quarantine is not enough: the urgent assessment needs a
   * second distinct reporter or a deterministic signal in the content.
   * Counted inside the quarantine transaction so concurrent reports see
   * each other.
   */
  private async isQuarantineCorroborated(
    dropId: string,
    snapshot: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<boolean> {
    const rule = getAutoQuarantineCorroborationRule();
    if (
      rule.signalCorroborates &&
      this.signalScreen.findContentPatternSignal(snapshotText(snapshot))
    ) {
      return true;
    }
    if (rule.minReporters <= 1) {
      return true;
    }
    const reporters = await this.db.countOpenReportersForDrop(
      dropId,
      ctx.connection
    );
    if (reporters >= rule.minReporters) {
      return true;
    }
    this.logger.info(
      `Urgent assessment for drop ${dropId} kept visible for human review: ${reporters} open reporter(s), no content signal`
    );
    return false;
  }

  /**
   * The parent is labelled so the evaluator can tell context the reporter
   * wrote apart from the reported author's text. Drop edit history is not
   * retained, so the parent is the current version and says so.
   */
  private async getParentContext(
    snapshot: Record<string, unknown> & { reply_to_drop_id?: unknown },
    reporterProfileId: string,
    ctx: RequestContext
  ): Promise<Record<string, unknown> | null> {
    if (typeof snapshot.reply_to_drop_id === 'string') {
      try {
        const parent = await this.db.getDropSnapshot(
          snapshot.reply_to_drop_id,
          ctx.connection
        );
        return {
          ...parent,
          context_role: 'PARENT_OF_REPORTED_DROP',
          authored_by_reporter: parent.author_profile_id === reporterProfileId,
          content_as_of: 'CURRENT_MAY_POSTDATE_REPLY'
        };
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }
    }
    return null;
  }

  private async assertModerator(profileId: string, ctx: RequestContext) {
    if (!(await isModerationDeveloper(profileId, ctx))) {
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
