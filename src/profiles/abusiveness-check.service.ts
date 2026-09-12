import {
  AiBasedAbusivenessDetector,
  aiBasedAbusivenessDetector
} from '@/abusiveness/ai-based-abusiveness.detector';
import { abusivenessCheckDb, AbusivenessCheckDb } from './abusiveness-check.db';
import { BadRequestException } from '@/exceptions';
import {
  AbusivenessDetectionResult,
  REP_CATEGORY_PATTERN
} from '@/entities/IAbusivenessDetectionResult';
import { RequestContext } from '@/request.context';
import {
  moderationReviewDb,
  ModerationReviewDb
} from '@/content-moderation/moderation-review.db';
import {
  activePermit,
  PUBLIC_TEXT_POLICY_VERSION,
  publicTextModel
} from '@/content-moderation/moderation-review.service';
import { ModerationInput } from '@/content-moderation/moderation-review.types';

export class AbusivenessCheckService {
  constructor(
    private readonly detector: AiBasedAbusivenessDetector,
    private readonly cache: AbusivenessCheckDb,
    private readonly reviews: ModerationReviewDb = moderationReviewDb
  ) {}
  async bulkCheckRepPhrases(phrases: string[], ctx: RequestContext) {
    for (const text of Array.from(
      new Set(phrases.map((phrase) => phrase.trim()))
    )) {
      const result = await this.rep(text, false, ctx);
      if (result.status !== 'ALLOWED')
        throw new BadRequestException(`REP phrase "${text}" is not allowed.`);
    }
  }
  async checkRepPhrase(
    text: string,
    ctx: RequestContext = {}
  ): Promise<AbusivenessDetectionResult> {
    return this.rep(text, true, ctx);
  }
  private async rep(text: string, failOpen: boolean, ctx: RequestContext) {
    const txt = text.trim();
    if (!txt.length || txt.length > 100)
      throw new BadRequestException('Text must be 1-100 characters');
    if (!REP_CATEGORY_PATTERN.test(txt))
      throw new BadRequestException(
        'Rep statement contains invalid characters'
      );
    const input: ModerationInput = {
      subject_type: 'REP_CATEGORY',
      subject_id: txt,
      author_profile_id: null,
      actor_profile_id:
        ctx.authenticationContext?.getLoggedInUsersProfileId() ?? null,
      operation: 'CLASSIFY',
      policy_family: 'PUBLIC_FIELDS',
      policy_version: PUBLIC_TEXT_POLICY_VERSION,
      scope: {
        acting_as_profile_id: ctx.authenticationContext?.getActingAsId() ?? null
      },
      evidence: { text: txt }
    };
    return this.evaluate(
      input,
      async () => this.detector.checkRepPhraseText(txt),
      failOpen,
      true
    );
  }
  async checkBio(query: {
    text: string;
    handle: string;
    profile_type: string;
    profile_id?: string;
    actor_profile_id?: string | null;
    current_revision?: string | null;
  }): Promise<AbusivenessDetectionResult> {
    const text = query.text.trim();
    if (text.length > 500)
      throw new BadRequestException('Text must be up to 500 characters');
    const id = query.profile_id ?? query.handle;
    return this.evaluate(
      {
        subject_type: 'PROFILE_BIO',
        subject_id: id,
        author_profile_id: id,
        actor_profile_id: query.actor_profile_id ?? id,
        operation: 'UPDATE',
        policy_family: 'PUBLIC_FIELDS',
        policy_version: PUBLIC_TEXT_POLICY_VERSION,
        scope: {
          handle: query.handle,
          profile_type: query.profile_type,
          current_revision: query.current_revision ?? null
        },
        evidence: { text }
      },
      async () =>
        this.detector.checkBioText({
          text,
          handle: query.handle,
          profile_type: query.profile_type
        }),
      false,
      false
    );
  }
  async checkFilterName(query: {
    text: string;
    handle: string;
    group_id?: string;
    profile_id?: string;
    actor_profile_id?: string | null;
    current_revision?: string | null;
    old_version_id?: string | null;
    visible?: boolean;
    context_fingerprint?: string;
    previously_reviewed?: boolean;
  }): Promise<AbusivenessDetectionResult> {
    const text = query.text.trim();
    if (text.length > 100)
      throw new BadRequestException('Text must be up to 100 characters');
    const safe =
      query.previously_reviewed ||
      text === 'Only Me' ||
      (!!query.handle && text === `Only ${query.handle}`);
    return this.evaluate(
      {
        subject_type: 'GROUP_NAME',
        subject_id:
          query.old_version_id ?? `${query.profile_id ?? query.handle}:new`,
        author_profile_id: query.profile_id ?? null,
        actor_profile_id: query.actor_profile_id ?? query.profile_id ?? null,
        operation: 'SAVE',
        policy_family: 'PUBLIC_FIELDS',
        policy_version: PUBLIC_TEXT_POLICY_VERSION,
        scope: {
          group_review: true,
          acting_as_profile_id: query.profile_id ?? null,
          handle: query.handle,
          current_revision: query.current_revision ?? null,
          old_version_id: query.old_version_id ?? null,
          visible: query.visible ?? true,
          context_fingerprint: query.context_fingerprint ?? null
        },
        evidence: { text }
      },
      async () =>
        safe
          ? {
              text,
              status: 'ALLOWED',
              explanation: 'Known personal group name',
              external_check_performed_at: new Date()
            }
          : this.detector.checkUserGroupName({ text, handle: query.handle }),
      false,
      false,
      safe
    );
  }
  private async evaluate(
    input: ModerationInput,
    classifier: () => Promise<AbusivenessDetectionResult>,
    failOpen: boolean,
    useCache: boolean,
    knownSafe = false
  ): Promise<AbusivenessDetectionResult> {
    const model = publicTextModel();
    const { item, evaluationId } = await this.reviews.start(
      input,
      knownSafe ? 'KNOWN_SAFE_PERSONAL_NAME' : 'PUBLIC_FIELD'
    );
    const text = input.evidence.text;
    if (typeof text !== 'string')
      throw new BadRequestException('Text evidence is unavailable');
    const finish = async (
      result: AbusivenessDetectionResult,
      cacheHit = false,
      fallback: string | null = null,
      manual = false
    ) => {
      await this.reviews.finish(evaluationId, {
        outcome: result.status === 'ALLOWED' ? 'ALLOW' : 'REJECT',
        result: { status: result.status, explanation: result.explanation },
        model: knownSafe || manual ? null : model,
        cacheHit,
        fallback
      });
      return { ...result, moderation_item_id: item.id };
    };
    if (item.override === 'BLOCK' || activePermit(item))
      return finish(
        {
          text,
          status: item.override === 'BLOCK' ? 'DISALLOWED' : 'ALLOWED',
          explanation: 'Explicit developer decision',
          external_check_performed_at: new Date()
        },
        true,
        null,
        true
      );
    const cached = await this.findCurrentCachedResult(
      text,
      input.policy_version,
      model,
      useCache
    );
    if (cached) return finish(cached, true);
    let result: AbusivenessDetectionResult;
    try {
      result = await classifier();
    } catch {
      await this.reviews.finish(evaluationId, {
        outcome: failOpen ? 'ALLOW' : 'ERROR',
        result: { error: 'EVALUATOR_UNAVAILABLE' },
        model,
        fallback: failOpen ? 'ALLOW' : 'REQUEST_FAILED'
      });
      if (!failOpen)
        throw new BadRequestException(
          'Content evaluation is temporarily unavailable. Please retry.'
        );
      return {
        text,
        status: 'ALLOWED',
        explanation: null,
        external_check_performed_at: new Date(),
        moderation_item_id: item.id
      };
    }
    if (useCache)
      await this.cache.saveVersionedResult({
        ...result,
        policy_version: input.policy_version,
        model
      });
    return finish(result);
  }

  private async findCurrentCachedResult(
    text: string,
    policyVersion: string,
    model: string,
    useCache: boolean
  ): Promise<AbusivenessDetectionResult | null> {
    if (!useCache) return null;
    const cached = await this.cache.findResult(text);
    if (cached?.policy_version !== policyVersion || cached.model !== model)
      return null;
    return cached;
  }
}
export const abusivenessCheckService = new AbusivenessCheckService(
  aiBasedAbusivenessDetector,
  abusivenessCheckDb,
  moderationReviewDb
);
