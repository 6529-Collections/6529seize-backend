import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { contentModerationDb } from './content-moderation.db';
import {
  contentModerationAiService,
  CONTENT_MODERATION_POLICY_VERSION,
  PRE_PUBLICATION_EVALUATOR_VERSION
} from './content-moderation-ai.service';
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  ModeratedProfileStatus
} from '@/entities/IContentModeration';
import {
  moderationReviewDb,
  ModerationReviewDb,
  moderationConflict
} from './moderation-review.db';
import {
  ModerationAction,
  ModerationInput,
  ModerationItem,
  moderationFingerprint
} from './moderation-review.types';
import { assertModerationDeveloper } from './moderation-developer-access';
import {
  getConfiguredBedrockAnthropicModelId,
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
} from '@/bedrock.config';

export const PUBLIC_TEXT_POLICY_VERSION = 'public-fields-2026-09-1';
export function publicTextModel(): string {
  return getConfiguredBedrockAnthropicModelId(
    'ABUSIVENESS_BEDROCK_MODEL_ID',
    DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
  );
}
export function activePermit(item: ModerationItem): boolean {
  return (
    item.override === 'ALLOW' &&
    (item.subject_type === 'REP_CATEGORY' ||
      (!!item.permit_expires_at && item.permit_expires_at > Date.now()))
  );
}
function evidenceExpired(item: ModerationItem): boolean {
  return (
    !item.evidence ||
    item.evidence.evidence_expired === true ||
    (item.evidence_expires_at !== null &&
      item.evidence_expires_at <= Date.now())
  );
}
export function checkPreview(item: ModerationItem): string | null {
  if (evidenceExpired(item)) return null;
  const text = item.evidence?.text ?? item.evidence?.title;
  return typeof text === 'string' ? text.slice(0, 160) : null;
}
export function itemSummary(item: ModerationItem) {
  const { evidence, ...check } = item;
  return { ...check, preview: checkPreview(item) };
}
export class ModerationReviewService {
  constructor(private readonly db: ModerationReviewDb) {}
  async reportCheck(reportId: string, ctx: RequestContext) {
    assertModerationDeveloper(ctx);
    const target = await this.db.reportForReview(reportId, ctx);
    if (target.item_id) return this.detail(target.item_id, ctx);
    const itemId = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        // Match the publication/action lock order before locking report rows.
        await this.db.lockProfile(target.author_profile_id, tx);
        await this.db.lockDrop(target.drop_id, tx);
        const report = await this.db.reportForReview(reportId, tx, true);
        if (report.item_id) return report.item_id;
        const evidence = report.content_snapshot;
        const parts = Array.isArray(evidence.parts)
          ? evidence.parts.map((part: { content?: string | null }) => ({
              content: part.content ?? null
            }))
          : [];
        const revision = moderationFingerprint({
          title: evidence.title ?? null,
          parts
        });
        const input: ModerationInput = {
          subject_type: 'DROP',
          subject_id: report.drop_id,
          author_profile_id: report.author_profile_id,
          actor_profile_id: report.reporter_profile_id,
          operation: 'REPORT',
          policy_family: 'WAVE_CONTENT',
          policy_version: report.ai_policy_version ?? 'legacy-unversioned',
          scope: {
            report_id: reportId,
            report_reason: report.reason,
            wave_id: evidence.wave_id ?? null,
            current_revision: revision
          },
          evidence
        };
        const started = await this.db.start(input, 'CONTENT_REPORTED', tx);
        await this.db.finish(
          started.evaluationId,
          {
            outcome: !report.ai_recommendation
              ? 'ERROR'
              : report.ai_recommendation === 'NO_VIOLATION_DETECTED'
                ? 'ALLOW'
                : 'REJECT',
            fallback: report.ai_recommendation
              ? null
              : 'LEGACY_ASSESSMENT_UNAVAILABLE',
            result: {
              recommendation: report.ai_recommendation,
              category: report.ai_category,
              confidence: report.ai_confidence,
              rationale: report.ai_rationale,
              evidence: report.ai_evidence,
              policy_version: report.ai_policy_version,
              assessed_at: report.ai_assessed_at,
              report: {
                id: report.id,
                reason: report.reason,
                notes: report.notes
              },
              legacy_record: true
            }
          },
          tx
        );
        await this.db.attachPublication(
          started.item.id,
          report.drop_id,
          revision,
          tx
        );
        await this.db.bindReport(reportId, started.item.id, tx);
        await this.db.refreshReportResolution(started.item.id, tx);
        return started.item.id;
      }
    );
    return this.detail(itemId, ctx);
  }
  async profileCheck(profileId: string, ctx: RequestContext) {
    const actor = assertModerationDeveloper(ctx);
    await contentModerationDb.getExistingProfileStatus(
      profileId,
      ctx.connection
    );
    const input: ModerationInput = {
      subject_type: 'PROFILE_BIO',
      subject_id: profileId,
      author_profile_id: profileId,
      actor_profile_id: actor,
      operation: 'PROFILE_STATUS',
      policy_family: 'PUBLIC_FIELDS',
      policy_version: PUBLIC_TEXT_POLICY_VERSION,
      scope: { administrative: true },
      evidence: {}
    };
    const existing = await this.db.find(input, ctx);
    let item = existing;
    if (!item) {
      const started = await this.db.start(input, 'PROFILE_STATUS', ctx);
      await this.db.finish(
        started.evaluationId,
        { outcome: 'ALLOW', result: { administrative: true } },
        ctx
      );
      item = started.item;
    }
    return this.detail(item.id, ctx);
  }

  async detail(id: string, ctx: RequestContext) {
    assertModerationDeveloper(ctx);
    const item = await this.db.get(id, ctx);
    const history = await this.db.history(id, ctx);
    const current = await this.db.currentRevision(item, ctx);
    const publishedRevision = item.scope.published_revision;
    const matches = publishedRevision
      ? current === publishedRevision
      : current === (item.scope.current_revision ?? null);
    const expired = evidenceExpired(item);
    const isPublished = !!item.published_subject_id;
    const suppressed =
      item.suppressed ||
      (!!item.published_subject_id &&
        !!publishedRevision &&
        ['PROFILE_BIO', 'GROUP_NAME'].includes(item.subject_type) &&
        (await this.db.isSuppressed(
          item.subject_type,
          item.published_subject_id,
          String(publishedRevision),
          ctx
        )));
    const actions: ModerationAction[] = ['MARK_REVIEWED'];
    if (item.override) actions.push('REVOKE_OVERRIDE');
    if (!expired) {
      actions.push('REEVALUATE');
      if (item.subject_type === 'REP_CATEGORY' || (matches && !isPublished))
        actions.push('ALLOW', 'BLOCK');
      if (
        isPublished &&
        matches &&
        ['PROFILE_BIO', 'GROUP_NAME'].includes(item.subject_type)
      )
        actions.push(suppressed ? 'RESTORE' : 'SUPPRESS');
      if (isPublished && matches && item.subject_type === 'DROP')
        actions.push('QUARANTINE', 'REMOVE', 'RESTORE');
      if (item.author_profile_id) actions.push('SUSPEND', 'REINSTATE');
    }
    if (item.scope.administrative)
      actions.splice(
        0,
        actions.length,
        'SUSPEND',
        'REINSTATE',
        'MARK_REVIEWED'
      );
    if (id.startsWith('routine:')) actions.splice(0, actions.length);
    const profileStatus = item.author_profile_id
      ? await contentModerationDb.getProfileStatus(
          item.author_profile_id,
          ctx.connection
        )
      : null;
    const presentations =
      item.subject_type === 'DROP' && item.published_subject_id
        ? await contentModerationDb.getPresentations(
            [
              {
                id: item.published_subject_id,
                author_id: item.author_profile_id ?? ''
              }
            ],
            null,
            ctx.connection
          )
        : {};
    return {
      check: itemSummary(item),
      evidence: expired ? null : item.evidence,
      current_revision_matches: matches,
      current_state: {
        profile_status: profileStatus,
        drop_status: item.published_subject_id
          ? (presentations[item.published_subject_id]?.moderation.status ??
            null)
          : null,
        published: isPublished,
        suppressed,
        revision: current
      },
      evidence_expired: expired,
      ...history,
      evaluations: history.evaluations.map((evaluation) => ({
        ...evaluation,
        result: expired ? null : evaluation.result
      })),
      allowed_actions: actions,
      action_effect: item.scope.administrative
        ? 'PROFILE_STATUS'
        : item.subject_type === 'REP_CATEGORY'
          ? 'GLOBAL_CATEGORY_RULE'
          : isPublished
            ? item.subject_type === 'DROP'
              ? 'PUBLISHED_DROP'
              : 'PUBLISHED_FIELD'
            : 'EXACT_RESUBMISSION_PERMIT'
    };
  }

  async action(
    id: string,
    input: {
      action: ModerationAction;
      reason: string;
      expected_version: number;
      idempotency_key: string;
    },
    ctx: RequestContext
  ) {
    const actor = assertModerationDeveloper(ctx);
    const actionId = `${actor}:${input.idempotency_key}`;
    if (input.action === 'REEVALUATE') {
      const claimed = await this.claimAction(id, input, actor, actionId, ctx);
      if (claimed) await this.reevaluate(claimed, ctx);
      return this.detail(id, ctx);
    }
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      const tx = { ...ctx, connection };
      await this.db.lockSubject(await this.db.get(id, tx), tx);
      const item = await this.db.get(id, tx, true);
      if (await this.checkIdempotency(item, input, actor, actionId, tx)) return;
      await this.checkAction(item, input, tx);
      await this.applyContentAction(
        item,
        input.action,
        input.reason,
        actor,
        tx
      );
      await this.db.invalidateRelatedVersions(item, input.action, tx);
      await this.db.decide(item, input.action, tx);
      await this.db.audit(
        item,
        { actor, action: input.action, reason: input.reason, actionId },
        tx
      );
    });
    return this.detail(id, ctx);
  }
  private async checkIdempotency(
    item: ModerationItem,
    input: { action: string; reason: string },
    actor: string,
    actionId: string,
    ctx: RequestContext
  ) {
    const prior = await this.db.priorAction(actionId, ctx);
    if (!prior) return false;
    if (
      prior.item_id !== item.id ||
      prior.actor_profile_id !== actor ||
      prior.action !== input.action ||
      prior.reason !== input.reason
    )
      moderationConflict();
    return true;
  }
  private async checkAction(
    item: ModerationItem,
    input: { action: ModerationAction; expected_version: number },
    ctx: RequestContext
  ) {
    if (item.version !== input.expected_version) moderationConflict();
    const detail = await this.detail(item.id, ctx);
    if (!detail.allowed_actions.includes(input.action))
      throw new BadRequestException(
        'This action is unavailable for the reviewed revision'
      );
  }
  private async claimAction(
    id: string,
    input: {
      action: ModerationAction;
      reason: string;
      expected_version: number;
    },
    actor: string,
    actionId: string,
    ctx: RequestContext
  ) {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const tx = { ...ctx, connection };
      await this.db.lockSubject(await this.db.get(id, tx), tx);
      const item = await this.db.get(id, tx, true);
      if (await this.checkIdempotency(item, input, actor, actionId, tx))
        return null;
      await this.checkAction(item, input, tx);
      await this.db.decide(item, 'REEVALUATE', tx);
      await this.db.audit(
        item,
        { actor, action: input.action, reason: input.reason, actionId },
        tx
      );
      return item;
    });
  }
  private async applyContentAction(
    item: ModerationItem,
    action: ModerationAction,
    reason: string,
    actor: string,
    ctx: RequestContext
  ) {
    if (action === 'SUSPEND' || action === 'REINSTATE') {
      if (item.author_profile_id === actor)
        throw new BadRequestException(
          'Developers cannot change their own suspension'
        );
      if (!item.author_profile_id)
        throw new BadRequestException(
          'No profile is associated with this item'
        );
      await contentModerationDb.setProfileStatus(
        {
          profileId: item.author_profile_id,
          moderatorProfileId: actor,
          status:
            action === 'SUSPEND'
              ? ModeratedProfileStatus.SUSPENDED
              : ModeratedProfileStatus.ACTIVE,
          reason
        },
        ctx
      );
    }
    if (
      item.subject_type === 'DROP' &&
      item.published_subject_id &&
      ['ALLOW', 'RESTORE', 'REMOVE', 'QUARANTINE'].includes(action)
    ) {
      const status =
        action === 'REMOVE'
          ? DropModerationStatus.MODERATOR_REMOVED
          : action === 'QUARANTINE'
            ? DropModerationStatus.AI_QUARANTINED
            : DropModerationStatus.VISIBLE;
      await contentModerationDb.applyModeratorDropDecision(
        {
          dropId: item.published_subject_id,
          status,
          actorProfileId: actor,
          action: `DEVELOPER_${action}`,
          reason,
          reportStatus:
            action === 'QUARANTINE'
              ? null
              : action === 'REMOVE'
                ? ContentReportStatus.RESOLVED_REMOVED
                : ContentReportStatus.RESOLVED_ALLOWED
        },
        ctx
      );
    }
  }
  private async reevaluate(item: ModerationItem, ctx: RequestContext) {
    if (!item.evidence) throw new BadRequestException('Evidence has expired');
    const input: ModerationInput = {
      ...item,
      policy_version:
        item.policy_family === 'PUBLIC_FIELDS'
          ? PUBLIC_TEXT_POLICY_VERSION
          : item.operation === 'REPORT'
            ? CONTENT_MODERATION_POLICY_VERSION
            : PRE_PUBLICATION_EVALUATOR_VERSION,
      evidence: item.evidence
    };
    const history = await this.db.history(item.id, ctx);
    const { evaluationId } = await this.db.start(
      input,
      'DEVELOPER_REEVALUATION',
      { ...ctx, connection: undefined },
      history.evaluations[0]?.id ?? null
    );
    let finished: Parameters<ModerationReviewDb['finish']>[1];
    try {
      finished = await this.assessOriginal(item);
    } catch {
      finished = {
        outcome: 'ERROR',
        result: { error: 'EVALUATOR_UNAVAILABLE' },
        fallback: 'HUMAN_REVIEW'
      };
    }
    // A storage failure propagates; it must never be mistaken for a model result.
    await this.db.finish(evaluationId, finished);
  }
  private async assessOriginal(
    item: ModerationItem
  ): Promise<Parameters<ModerationReviewDb['finish']>[1]> {
    const evidence = item.evidence!;
    if (item.policy_family === 'PUBLIC_FIELDS') {
      const { aiBasedAbusivenessDetector } =
        await import('@/abusiveness/ai-based-abusiveness.detector');
      const text = String(evidence.text ?? '');
      const assessment =
        item.subject_type === 'REP_CATEGORY'
          ? await aiBasedAbusivenessDetector.checkRepPhraseText(text)
          : item.subject_type === 'PROFILE_BIO'
            ? await aiBasedAbusivenessDetector.checkBioText({
                text,
                handle: String(item.scope.handle ?? ''),
                profile_type: String(item.scope.profile_type ?? '')
              })
            : await aiBasedAbusivenessDetector.checkUserGroupName({
                text,
                handle: String(item.scope.handle ?? '')
              });
      return {
        outcome: assessment.status === 'ALLOWED' ? 'ALLOW' : 'REJECT',
        result: { ...assessment },
        model: publicTextModel()
      };
    }
    const model = getConfiguredBedrockAnthropicModelId(
      'CONTENT_MODERATION_BEDROCK_MODEL_ID',
      DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID
    );
    if (item.operation === 'REPORT') {
      const assessment = await contentModerationAiService.assessReportedContent(
        {
          reason: (item.scope.report_reason ??
            ContentReportReason.OTHER) as ContentReportReason,
          content: evidence,
          parentContext: evidence.parent_context as Record<
            string,
            unknown
          > | null
        }
      );
      return {
        outcome:
          assessment.recommendation ===
          ContentModerationRecommendation.NO_VIOLATION_DETECTED
            ? 'ALLOW'
            : 'REJECT',
        result: { ...assessment },
        model
      };
    }
    const parts = Array.isArray(evidence.parts)
      ? (evidence.parts as Array<{ content?: string | null }>)
      : [];
    const assessment = await contentModerationAiService.assessPrePublication({
      signal: String(item.scope.deterministic_signal ?? item.trigger),
      content: [evidence.title, ...parts.map((part) => part.content)]
        .filter(Boolean)
        .join('\n')
    });
    return {
      outcome:
        assessment.outcome === 'REJECT' && assessment.confidence >= 0.95
          ? 'REJECT'
          : 'ALLOW',
      result: { ...assessment },
      model
    };
  }
}
export const moderationReviewService = new ModerationReviewService(
  moderationReviewDb
);
