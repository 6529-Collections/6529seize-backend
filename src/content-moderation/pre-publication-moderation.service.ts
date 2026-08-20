import { env } from '@/env';
import {
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import {
  contentModerationAiService,
  ContentModerationAiService,
  PRE_PUBLICATION_EVALUATOR_VERSION
} from './content-moderation-ai.service';
import {
  contentModerationDb,
  ContentModerationDb
} from './content-moderation.db';

export const PRE_PUBLICATION_GATE_VERSION = 'deterministic-gate-2026-08-1';
const DUPLICATE_WINDOW = Time.minutes(10);
const DUPLICATE_SIGNAL_THRESHOLD = 4;
const URL_EDGE_PUNCTUATION = new Set(['.', '!', '?', ';', ':']);

export interface PrePublicationDropInput {
  readonly dropId: string;
  readonly authorProfileId: string;
  readonly operation: 'CREATE' | 'UPDATE';
  readonly title: string | null;
  readonly parts: ReadonlyArray<{ readonly content: string | null }>;
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

export class PrePublicationModerationService {
  private readonly logger = Logger.get(PrePublicationModerationService.name);

  constructor(
    private readonly moderationDb: ContentModerationDb,
    private readonly aiService: ContentModerationAiService
  ) {}

  async evaluate(
    input: PrePublicationDropInput,
    ctx: RequestContext
  ): Promise<void> {
    const profileStatus = await this.moderationDb.getProfileStatus(
      input.authorProfileId,
      ctx.connection
    );
    if (profileStatus === ModeratedProfileStatus.SUSPENDED) {
      throw new ForbiddenException(
        'This profile is currently suspended from posting. Contact support if you believe this is an error.'
      );
    }

    const content = getPrePublicationTextContent(input);
    const contentFingerprint = getPrePublicationContentFingerprint(input);
    const screen = await this.runDeterministicScreen(
      input,
      content,
      contentFingerprint,
      ctx
    );
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
      throw new CustomApiCompliantException(422, screen.directRejectionReason);
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
      return;
    }

    let assessment: Awaited<
      ReturnType<ContentModerationAiService['assessPrePublication']>
    >;
    try {
      assessment = await this.aiService.assessPrePublication({
        signal: screen.signal,
        content
      });
    } catch (error) {
      this.logger.error(
        'Pre-publication evaluator failed; allowing ambiguous content',
        error
      );
      await this.record(
        input,
        {
          contentFingerprint,
          signal: screen.signal,
          outcome: PrePublicationCheckOutcome.ALLOW,
          aiInvoked: true,
          evaluatorResult: {
            evaluator_error: true,
            fallback: 'ALLOW'
          }
        },
        ctx
      );
      return;
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
        signal: screen.signal,
        outcome,
        aiInvoked: true,
        evaluatorResult: { ...assessment }
      },
      ctx
    );
    if (outcome === PrePublicationCheckOutcome.REJECT) {
      throw new CustomApiCompliantException(
        422,
        `This post couldn't be submitted because it appears to conflict with the platform's safety rules. You can edit and try again, or contact support if you believe this is a mistake.`
      );
    }
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
    await this.moderationDb.recordPrePublicationCheck(
      {
        dropId: input.dropId,
        authorProfileId: input.authorProfileId,
        operation: input.operation,
        deterministicGateVersion: PRE_PUBLICATION_GATE_VERSION,
        contentFingerprint: result.contentFingerprint,
        signal: result.signal,
        outcome: result.outcome,
        evaluatorVersion: result.aiInvoked
          ? PRE_PUBLICATION_EVALUATOR_VERSION
          : null,
        evaluatorResult: result.evaluatorResult
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
