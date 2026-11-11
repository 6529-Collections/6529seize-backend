import { env } from '@/env';
import {
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { moderationReviewDb, ModerationReviewDb } from './moderation-review.db';
import {
  activePermit,
  publicationPermitGeneration
} from './moderation-review.service';
import { ModerationInput } from './moderation-review.types';
import {
  contentModerationAiService,
  ContentModerationAiService,
  getContentModerationBedrockModelId,
  PRE_PUBLICATION_EVALUATOR_VERSION
} from './content-moderation-ai.service';
import {
  contentModerationDb,
  ContentModerationDb
} from './content-moderation.db';
import {
  getPrePublicationEvaluatorProfileHourlyLimit,
  PRE_PUBLICATION_EVALUATOR_BUDGET_WINDOW,
  PRE_PUBLICATION_EVALUATOR_FALLBACK_LOG_MARKER,
  PrePublicationVerdictCache,
  prePublicationVerdictCacheKey,
  recordPrePublicationEvaluatorEvent,
  redisPrePublicationVerdictCache
} from './pre-publication-evaluator-guards';

export const PRE_PUBLICATION_GATE_VERSION = 'deterministic-gate-2026-08-1';
export const CONTENT_MODERATION_REJECTION_CODE = 'CONTENT_MODERATION_REJECTED';
export const PROFILE_SUSPENDED_REJECTION_CODE = 'PROFILE_SUSPENDED';
export const CONTENT_MODERATION_REVIEW_LIMIT_CODE =
  'CONTENT_MODERATION_REVIEW_LIMIT';
const DUPLICATE_WINDOW = Time.minutes(10);
const DUPLICATE_SIGNAL_THRESHOLD = 4;
const URL_EDGE_PUNCTUATION = new Set(['.', '!', '?', ';', ':']);

export interface PrePublicationDropInput {
  readonly waveId?: string;
  readonly currentRevision?: string | null;
  readonly contextFingerprint?: string;
  readonly reviewItemId?: string;
  readonly reviewEvaluationId?: string;
  readonly dropId: string;
  readonly authorProfileId: string;
  readonly operation: 'CREATE' | 'UPDATE';
  readonly title: string | null;
  readonly parts: ReadonlyArray<{ readonly content: string | null }>;
}

export interface PrePublicationEvaluateOptions {
  /**
   * Cheap authorization and wave validation for the write. It runs only when
   * the content needs the model evaluator, and before any review item is
   * opened or the evaluator is called, so a write that would fail validation
   * never reaches the model.
   */
  readonly beforeModelEvaluation?: () => Promise<void>;
}

export interface PrePublicationDecision {
  readonly itemId: string;
  readonly permitGeneration?: number;
}
function publicationDecision(
  input: PrePublicationDropInput,
  permitGeneration?: number
): PrePublicationDecision | undefined {
  return input.reviewItemId
    ? { itemId: input.reviewItemId, permitGeneration }
    : undefined;
}

function getPrePublicationTextContent(
  input: Pick<PrePublicationDropInput, 'title' | 'parts'>
): string {
  return [input.title, ...input.parts.map((part) => part.content)]
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

export function getPrePublicationContentFingerprint(
  input: Pick<PrePublicationDropInput, 'title' | 'parts'>
): string {
  const normalized = getPrePublicationTextContent(input)
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

interface DeterministicScreenResult {
  readonly signal: string | null;
  readonly directRejectionReason: string | null;
}

function makeReviewInput(
  input: PrePublicationDropInput,
  signal: string | null,
  ctx: RequestContext
): ModerationInput {
  return {
    subject_type: 'DROP',
    subject_id:
      input.operation === 'CREATE'
        ? `${input.authorProfileId}:${input.waveId ?? ''}`
        : input.dropId,
    author_profile_id: input.authorProfileId,
    actor_profile_id:
      ctx.authenticationContext?.getLoggedInUsersProfileId() ??
      input.authorProfileId,
    operation: input.operation,
    policy_family: 'WAVE_CONTENT',
    policy_version: PRE_PUBLICATION_EVALUATOR_VERSION,
    scope: {
      acting_as_profile_id: input.authorProfileId,
      deterministic_signal: signal,
      wave_id: input.waveId ?? null,
      current_revision: input.currentRevision ?? null,
      context_fingerprint: input.contextFingerprint ?? null
    },
    evidence: { title: input.title, parts: input.parts }
  };
}

export class PrePublicationModerationService {
  private readonly logger = Logger.get(PrePublicationModerationService.name);

  constructor(
    private readonly moderationDb: ContentModerationDb,
    private readonly aiService: ContentModerationAiService,
    private readonly reviews: ModerationReviewDb = moderationReviewDb,
    private readonly verdictCache: PrePublicationVerdictCache = redisPrePublicationVerdictCache
  ) {}

  async assertPostingAllowed(
    profileId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (
      (await this.moderationDb.getProfileStatus(profileId, ctx.connection)) ===
      ModeratedProfileStatus.SUSPENDED
    ) {
      throw new CustomApiCompliantException(
        403,
        'This profile is currently suspended from posting.',
        PROFILE_SUSPENDED_REJECTION_CODE
      );
    }
  }

  async evaluate(
    input: PrePublicationDropInput,
    ctx: RequestContext,
    options: PrePublicationEvaluateOptions = {}
  ): Promise<PrePublicationDecision | undefined> {
    const profileStatus = await this.moderationDb.getProfileStatus(
      input.authorProfileId,
      ctx.connection
    );
    const content = getPrePublicationTextContent(input);
    const contentFingerprint = getPrePublicationContentFingerprint(input);
    const screen =
      profileStatus === ModeratedProfileStatus.SUSPENDED
        ? { signal: 'PROFILE_SUSPENDED', directRejectionReason: null }
        : await this.runDeterministicScreen(
            input,
            content,
            contentFingerprint,
            ctx
          );
    if (
      screen.signal &&
      !screen.directRejectionReason &&
      profileStatus !== ModeratedProfileStatus.SUSPENDED
    ) {
      await options.beforeModelEvaluation?.();
    }
    const reviewInput = makeReviewInput(input, screen.signal, ctx);
    const existingReview = await this.reviews.find(reviewInput, ctx);
    const detailed =
      !!existingReview ||
      !!screen.signal ||
      profileStatus === ModeratedProfileStatus.SUSPENDED;
    if (detailed) {
      const review = await this.reviews.start(
        reviewInput,
        profileStatus === ModeratedProfileStatus.SUSPENDED
          ? 'PROFILE_SUSPENDED'
          : (screen.signal ?? 'MANUAL_OVERRIDE'),
        { ...ctx, connection: undefined }
      );
      input = {
        ...input,
        reviewItemId: review.item.id,
        reviewEvaluationId: review.evaluationId
      };
    }
    if (profileStatus === ModeratedProfileStatus.SUSPENDED) {
      await this.record(
        input,
        {
          contentFingerprint,
          signal: 'PROFILE_SUSPENDED',
          outcome: PrePublicationCheckOutcome.REJECT,
          aiInvoked: false,
          evaluatorResult: { reason: 'PROFILE_SUSPENDED' }
        },
        ctx
      );
      throw new CustomApiCompliantException(
        403,
        'This profile is currently suspended from posting. Contact support if you believe this is an error.',
        PROFILE_SUSPENDED_REJECTION_CODE
      );
    }

    if (screen.directRejectionReason) {
      await this.record(
        input,
        {
          contentFingerprint,
          signal: screen.signal,
          outcome: PrePublicationCheckOutcome.REJECT,
          aiInvoked: false,
          evaluatorResult: {
            rationale: screen.directRejectionReason,
            direct_rejection: true
          }
        },
        ctx
      );
      throw new CustomApiCompliantException(
        422,
        screen.directRejectionReason,
        CONTENT_MODERATION_REJECTION_CODE
      );
    }
    if (existingReview?.override === 'BLOCK') {
      await this.record(
        input,
        {
          contentFingerprint,
          signal: screen.signal ?? 'MANUAL_OVERRIDE',
          outcome: PrePublicationCheckOutcome.REJECT,
          aiInvoked: false,
          evaluatorResult: { reason: 'DEVELOPER_BLOCKED' }
        },
        ctx
      );
      throw new CustomApiCompliantException(
        422,
        'This exact submission was rejected after review.',
        CONTENT_MODERATION_REJECTION_CODE
      );
    }
    if (!screen.signal) {
      await this.record(
        input,
        {
          contentFingerprint,
          signal: null,
          outcome: PrePublicationCheckOutcome.ALLOW,
          aiInvoked: false,
          evaluatorResult: null
        },
        ctx
      );
      return publicationDecision(input);
    }

    if (existingReview && activePermit(existingReview)) {
      const generation = publicationPermitGeneration(existingReview);
      await this.record(
        input,
        {
          contentFingerprint,
          signal: screen.signal,
          outcome: PrePublicationCheckOutcome.ALLOW,
          aiInvoked: false,
          evaluatorResult: {
            manual_permit: true,
            permit_generation: generation
          }
        },
        ctx
      );
      return publicationDecision(input, generation);
    }
    const signal = screen.signal;
    const verdictKey = prePublicationVerdictCacheKey({
      policyVersion: PRE_PUBLICATION_EVALUATOR_VERSION,
      modelId: getContentModerationBedrockModelId(),
      signal,
      content
    });
    const cachedAssessment = await this.verdictCache.get(verdictKey);
    let assessment: Awaited<
      ReturnType<ContentModerationAiService['assessPrePublication']>
    >;
    if (cachedAssessment) {
      recordPrePublicationEvaluatorEvent('CACHED_VERDICT');
      assessment = cachedAssessment;
    } else {
      await this.assertEvaluatorBudget(
        input,
        { contentFingerprint, signal },
        ctx
      );
      try {
        assessment = await this.aiService.assessPrePublication({
          signal,
          content
        });
      } catch (error) {
        // Unchanged product behaviour: an unavailable evaluator allows the
        // post. The marker and metric make every such fallback visible.
        recordPrePublicationEvaluatorEvent('ERROR_FALLBACK_ALLOW');
        this.logger.error(
          `${PRE_PUBLICATION_EVALUATOR_FALLBACK_LOG_MARKER} Pre-publication evaluator failed; allowing ambiguous content`,
          {
            signal,
            authorProfileId: input.authorProfileId,
            error: error instanceof Error ? error.message : String(error)
          }
        );
        await this.record(
          input,
          {
            contentFingerprint,
            signal,
            outcome: PrePublicationCheckOutcome.ALLOW,
            aiInvoked: true,
            evaluatorResult: {
              evaluator_error: true,
              fallback: 'ALLOW'
            }
          },
          ctx
        );
        return publicationDecision(input);
      }
      recordPrePublicationEvaluatorEvent('INVOKED');
      await this.verdictCache.set(verdictKey, assessment);
    }

    const outcome =
      assessment.outcome === PrePublicationCheckOutcome.REJECT &&
      assessment.confidence >= 0.95
        ? PrePublicationCheckOutcome.REJECT
        : PrePublicationCheckOutcome.ALLOW;
    await this.record(
      input,
      {
        contentFingerprint,
        signal,
        outcome,
        // A cached verdict made no model call, so it is not counted against
        // the profile's evaluator budget.
        aiInvoked: !cachedAssessment,
        evaluatorResult: cachedAssessment
          ? { ...assessment, cached_verdict: true }
          : { ...assessment }
      },
      ctx
    );
    if (outcome === PrePublicationCheckOutcome.REJECT) {
      throw new CustomApiCompliantException(
        422,
        `This post couldn't be submitted because it appears to conflict with the platform's safety rules. You can edit and try again, or contact support if you believe this is a mistake.`,
        CONTENT_MODERATION_REJECTION_CODE
      );
    }
    return publicationDecision(input);
  }

  /**
   * Each profile may cause a bounded number of evaluator calls per rolling
   * hour. Beyond it the post is refused with a retry-later response instead
   * of calling the model again.
   */
  private async assertEvaluatorBudget(
    input: PrePublicationDropInput,
    {
      contentFingerprint,
      signal
    }: { readonly contentFingerprint: string; readonly signal: string },
    ctx: RequestContext
  ): Promise<void> {
    const limit = getPrePublicationEvaluatorProfileHourlyLimit();
    const used = await this.moderationDb.countRecentEvaluatorInvocations(
      {
        authorProfileId: input.authorProfileId,
        since:
          Time.currentMillis() -
          PRE_PUBLICATION_EVALUATOR_BUDGET_WINDOW.toMillis()
      },
      ctx.connection
    );
    if (used < limit) {
      return;
    }
    recordPrePublicationEvaluatorEvent('BUDGET_EXCEEDED');
    this.logger.warn(
      `Pre-publication evaluator budget of ${limit} per hour reached for profile ${input.authorProfileId}`
    );
    await this.record(
      input,
      {
        contentFingerprint,
        signal,
        outcome: PrePublicationCheckOutcome.REJECT,
        aiInvoked: false,
        evaluatorResult: { reason: 'EVALUATOR_BUDGET_EXCEEDED', limit }
      },
      ctx
    );
    throw new CustomApiCompliantException(
      429,
      'Several of your recent posts needed an extra review. Please wait a while before posting this again.',
      CONTENT_MODERATION_REVIEW_LIMIT_CODE
    );
  }

  /**
   * The content-only part of the deterministic screen: every signal except
   * the repeated-content check, which needs history. Used to corroborate
   * reported content.
   */
  findContentPatternSignal(content: string): string | null {
    if (this.findKnownMaliciousHost(content)) {
      return 'KNOWN_MALICIOUS_DESTINATION';
    }
    if (!content) {
      return null;
    }
    if (this.hasStructuredSensitiveDataSignal(content)) {
      return 'STRUCTURED_SENSITIVE_DATA';
    }
    if (this.hasExplicitThreatSignal(content)) {
      return 'EXPLICIT_THREAT_PATTERN';
    }
    if (this.hasSexualExploitationSignal(content)) {
      return 'SEXUAL_EXPLOITATION_PATTERN';
    }
    return null;
  }

  private async runDeterministicScreen(
    input: PrePublicationDropInput,
    content: string,
    contentFingerprint: string,
    ctx: RequestContext
  ): Promise<DeterministicScreenResult> {
    const maliciousHost = this.findKnownMaliciousHost(content);
    if (maliciousHost) {
      return {
        signal: 'KNOWN_MALICIOUS_DESTINATION',
        directRejectionReason: `This post couldn't be submitted because it links to a known unsafe destination (${maliciousHost}). Remove the link and try again, or contact support if you believe this is a mistake.`
      };
    }
    if (!content) {
      return { signal: null, directRejectionReason: null };
    }
    const duplicateCount = await this.moderationDb.countRecentMatchingDrops(
      {
        authorProfileId: input.authorProfileId,
        contentFingerprint,
        since: Time.currentMillis() - DUPLICATE_WINDOW.toMillis(),
        excludeDropId: input.operation === 'UPDATE' ? input.dropId : null
      },
      ctx.connection
    );
    if (duplicateCount >= DUPLICATE_SIGNAL_THRESHOLD) {
      return {
        signal: 'REPEATED_IDENTICAL_CONTENT',
        directRejectionReason: null
      };
    }
    if (this.hasStructuredSensitiveDataSignal(content)) {
      return {
        signal: 'STRUCTURED_SENSITIVE_DATA',
        directRejectionReason: null
      };
    }
    if (this.hasExplicitThreatSignal(content)) {
      return {
        signal: 'EXPLICIT_THREAT_PATTERN',
        directRejectionReason: null
      };
    }
    if (this.hasSexualExploitationSignal(content)) {
      return {
        signal: 'SEXUAL_EXPLOITATION_PATTERN',
        directRejectionReason: null
      };
    }
    return { signal: null, directRejectionReason: null };
  }

  private findKnownMaliciousHost(content: string): string | null {
    const blockedHosts = new Set(
      env
        .getStringArray('CONTENT_MODERATION_BLOCKED_HOSTS', ',')
        .map((host) => this.normalizeHost(host))
        .filter((host): host is string => host !== null)
    );
    if (!blockedHosts.size) {
      return null;
    }
    const candidates = content
      .split(/\s+/)
      .flatMap((token) => token.split(/[()[\]{}<>"',]+/))
      .map((token) => this.trimUrlPunctuation(token))
      .filter((token) => token.includes('.'));
    for (const candidate of candidates) {
      try {
        const candidateUrl = this.toParseableUrl(candidate);
        const host = this.normalizeHost(new URL(candidateUrl).hostname);
        if (!host) {
          continue;
        }
        if (
          blockedHosts.has(host) ||
          Array.from(blockedHosts).some((blocked) =>
            host.endsWith(`.${blocked}`)
          )
        ) {
          return host;
        }
      } catch {
        // Invalid URLs are handled by existing payload/link validation.
      }
    }
    return null;
  }

  private normalizeHost(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    let hostname = trimmed;
    try {
      if (trimmed.indexOf('://') > 0) {
        hostname = new URL(trimmed).hostname;
      }
    } catch {
      return null;
    }
    let normalizedHostname = hostname.toLocaleLowerCase();
    while (normalizedHostname.endsWith('.')) {
      normalizedHostname = normalizedHostname.slice(0, -1);
    }
    if (normalizedHostname.startsWith('www.')) {
      normalizedHostname = normalizedHostname.slice(4);
    }
    const ascii = domainToASCII(normalizedHostname);
    return ascii || null;
  }

  private trimUrlPunctuation(value: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && URL_EDGE_PUNCTUATION.has(value[start] ?? '')) {
      start += 1;
    }
    while (end > start && URL_EDGE_PUNCTUATION.has(value[end - 1] ?? '')) {
      end -= 1;
    }
    return value.slice(start, end);
  }

  private toParseableUrl(candidate: string): string {
    if (candidate.startsWith('//')) {
      return `https:${candidate}`;
    }
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }
    return `https://${candidate}`;
  }

  private hasStructuredSensitiveDataSignal(content: string): boolean {
    const socialSecurityNumber = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
    const paymentCardNumbers = content.matchAll(
      /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g
    );
    return (
      socialSecurityNumber.test(content) ||
      Array.from(paymentCardNumbers).some(([candidate]) =>
        this.isLuhnValid(candidate.replace(/[^\d]/g, ''))
      )
    );
  }

  private isLuhnValid(value: string): boolean {
    if (value.length < 13 || value.length > 19) {
      return false;
    }
    let sum = 0;
    let doubleDigit = false;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      let digit = Number(value[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  }

  private hasExplicitThreatSignal(content: string): boolean {
    return /\b(?:i|we)\s+(?:will|am going to|are going to|gonna)\s+(?:kill|murder|shoot|stab)\s+(?:you|him|her|them)\b/i.test(
      content
    );
  }

  private hasSexualExploitationSignal(content: string): boolean {
    return /\b(?:child|minor|underage)\b[\s\S]{0,50}\b(?:sexual|porn(?:ography)?|nude|naked)\b/i.test(
      content
    );
  }

  private async record(
    input: PrePublicationDropInput,
    result: {
      contentFingerprint: string;
      signal: string | null;
      outcome: PrePublicationCheckOutcome;
      aiInvoked: boolean;
      evaluatorResult: Record<string, unknown> | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (input.reviewEvaluationId) {
      await this.reviews.finish(input.reviewEvaluationId, {
        outcome: result.outcome,
        result: result.evaluatorResult ?? {},
        model: result.aiInvoked ? getContentModerationBedrockModelId() : null,
        fallback: result.evaluatorResult?.evaluator_error ? 'ALLOW' : null
      });
    }
    await this.moderationDb.recordPrePublicationCheck(
      {
        dropId: input.dropId,
        authorProfileId: input.authorProfileId,
        operation: input.operation,
        deterministicGateVersion: PRE_PUBLICATION_GATE_VERSION,
        contentFingerprint: result.contentFingerprint,
        deterministicSignal: result.signal,
        outcome: result.outcome,
        evaluatorVersion: result.aiInvoked
          ? PRE_PUBLICATION_EVALUATOR_VERSION
          : null,
        evaluatorResult: result.evaluatorResult,
        itemId: input.reviewItemId ?? null
      },
      ctx.connection
    );
  }
}

export const prePublicationModerationService =
  new PrePublicationModerationService(
    contentModerationDb,
    contentModerationAiService
  );
