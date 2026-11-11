import {
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { CustomApiCompliantException } from '@/exceptions';
import {
  CONTENT_MODERATION_REJECTION_CODE,
  CONTENT_MODERATION_REVIEW_LIMIT_CODE,
  PROFILE_SUSPENDED_REJECTION_CODE,
  PrePublicationModerationService
} from './pre-publication-moderation.service';
import { ModerationReviewDb } from './moderation-review.db';
import { Logger } from '@/logging';
import {
  DEFAULT_PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT,
  PRE_PUBLICATION_EVALUATOR_FALLBACK_LOG_MARKER
} from './pre-publication-evaluator-guards';

function createService({
  ServiceClass = PrePublicationModerationService,
  verdicts = new Map<string, unknown>()
}: {
  ServiceClass?: typeof PrePublicationModerationService;
  verdicts?: Map<string, unknown>;
} = {}) {
  const moderationDb = {
    getProfileStatus: jest
      .fn()
      .mockResolvedValue(ModeratedProfileStatus.ACTIVE),
    countRecentMatchingDrops: jest.fn().mockResolvedValue(0),
    countRecentEvaluatorInvocations: jest.fn().mockResolvedValue(0),
    recordPrePublicationCheck: jest.fn().mockResolvedValue(undefined)
  };
  const verdictCache = {
    get: jest.fn(async (key: string) => (verdicts.get(key) as any) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      verdicts.set(key, value);
    })
  };
  const aiService = {
    assessPrePublication: jest.fn().mockResolvedValue({
      outcome: PrePublicationCheckOutcome.ALLOW,
      category: 'NONE',
      confidence: 0.2,
      rationale: 'Allowed'
    })
  };
  const reviews = {
    find: jest.fn().mockResolvedValue(null),
    start: jest.fn().mockResolvedValue({
      item: { id: 'review-item' },
      evaluationId: 'evaluation'
    }),
    finish: jest.fn().mockResolvedValue(undefined)
  };
  return {
    service: new ServiceClass(
      moderationDb as any,
      aiService as any,
      reviews as unknown as ModerationReviewDb,
      verdictCache
    ),
    moderationDb,
    aiService,
    reviews,
    verdictCache
  };
}

/**
 * The service loaded in its own module registry with a different evaluator
 * policy version, as a deployment with an updated policy would run it.
 */
function serviceClassWithPolicyVersion(
  policyVersion: string
): typeof PrePublicationModerationService {
  let ServiceClass: typeof PrePublicationModerationService;
  jest.isolateModules(() => {
    jest.doMock('./content-moderation-ai.service', () => ({
      ...jest.requireActual('./content-moderation-ai.service'),
      PRE_PUBLICATION_EVALUATOR_VERSION: policyVersion
    }));
    ServiceClass =
      require('./pre-publication-moderation.service').PrePublicationModerationService;
  });
  jest.dontMock('./content-moderation-ai.service');
  return ServiceClass!;
}

function input(content: string) {
  return {
    dropId: 'drop-1',
    authorProfileId: 'profile-1',
    operation: 'CREATE' as const,
    title: null,
    parts: [{ content }]
  };
}

describe('PrePublicationModerationService', () => {
  const originalBlockedHosts = process.env.CONTENT_MODERATION_BLOCKED_HOSTS;

  afterEach(() => {
    if (originalBlockedHosts === undefined) {
      delete process.env.CONTENT_MODERATION_BLOCKED_HOSTS;
    } else {
      process.env.CONTENT_MODERATION_BLOCKED_HOSTS = originalBlockedHosts;
    }
    jest.restoreAllMocks();
  });

  it('allows ordinary profanity without invoking AI', async () => {
    const { service, moderationDb, aiService } = createService();

    await expect(
      service.evaluate(input('This is fucking ridiculous'), {})
    ).resolves.toBeUndefined();

    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.ALLOW,
        deterministicSignal: null,
        evaluatorVersion: null,
        contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }),
      undefined
    );
  });

  it('rejects a configured malicious destination without invoking AI', async () => {
    process.env.CONTENT_MODERATION_BLOCKED_HOSTS = 'scam.example';
    const { service, moderationDb, aiService } = createService();

    const result = service.evaluate(
      input('Visit https://login.scam.example/connect now'),
      {}
    );

    await expect(result).rejects.toBeInstanceOf(CustomApiCompliantException);
    await expect(result).rejects.toMatchObject({
      code: CONTENT_MODERATION_REJECTION_CODE,
      message: expect.stringContaining('known unsafe destination')
    });
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.REJECT,
        deterministicSignal: 'KNOWN_MALICIOUS_DESTINATION',
        evaluatorVersion: null
      }),
      undefined
    );
  });

  it('allows an uncertain AI result after a narrow deterministic signal', async () => {
    const { service, moderationDb, aiService } = createService();
    aiService.assessPrePublication.mockResolvedValue({
      outcome: PrePublicationCheckOutcome.REJECT,
      category: 'CREDIBLE_THREAT_OF_VIOLENCE',
      confidence: 0.94,
      rationale: 'Not certain enough'
    });

    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toEqual({
      itemId: 'review-item',
      permitGeneration: undefined
    });

    expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.ALLOW,
        deterministicSignal: 'EXPLICIT_THREAT_PATTERN',
        evaluatorVersion: expect.any(String)
      }),
      undefined
    );
  });

  it('rejects only a high-confidence explicit AI violation', async () => {
    const { service, aiService } = createService();
    aiService.assessPrePublication.mockResolvedValue({
      outcome: PrePublicationCheckOutcome.REJECT,
      category: 'CREDIBLE_THREAT_OF_VIOLENCE',
      confidence: 0.99,
      rationale: 'Explicit threat'
    });

    const result = service.evaluate(input('I will kill you'), {});

    await expect(result).rejects.toBeInstanceOf(CustomApiCompliantException);
    await expect(result).rejects.toMatchObject({
      code: CONTENT_MODERATION_REJECTION_CODE,
      message: expect.stringContaining("platform's safety rules")
    });
  });

  it('normalizes scheme-less and unicode malicious hosts', async () => {
    process.env.CONTENT_MODERATION_BLOCKED_HOSTS =
      'https://t\u00e9st.example./';
    const { service, aiService } = createService();

    const result = service.evaluate(input('Avoid t\u00e9st.example/login'), {});

    await expect(result).rejects.toBeInstanceOf(CustomApiCompliantException);
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
  });

  it('finds a configured malicious host inside a markdown link', async () => {
    process.env.CONTENT_MODERATION_BLOCKED_HOSTS = 'scam.example';
    const { service, aiService } = createService();

    const result = service.evaluate(
      input('Use [this login](scam.example/connect)'),
      {}
    );

    await expect(result).rejects.toBeInstanceOf(CustomApiCompliantException);
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
  });

  it('fails open when the AI evaluator is unavailable', async () => {
    const { service, moderationDb, aiService } = createService();
    aiService.assessPrePublication.mockRejectedValue(new Error('unavailable'));

    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toEqual({
      itemId: 'review-item',
      permitGeneration: undefined
    });

    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.ALLOW,
        evaluatorResult: expect.objectContaining({ evaluator_error: true })
      }),
      undefined
    );
  });

  it('routes only Luhn-valid payment card candidates to AI', async () => {
    const { service, aiService } = createService();

    await service.evaluate(
      input('Stripe sandbox test card: 4242 4242 4242 4242'),
      {}
    );
    expect(aiService.assessPrePublication).toHaveBeenCalledWith({
      signal: 'STRUCTURED_SENSITIVE_DATA',
      content: 'Stripe sandbox test card: 4242 4242 4242 4242'
    });

    aiService.assessPrePublication.mockClear();
    await service.evaluate(input('Reference 4242 4242 4242 4241'), {});
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
  });

  it('rejects claimed real card data after a high-confidence sensitive-data assessment', async () => {
    const { service, moderationDb, aiService } = createService();
    aiService.assessPrePublication.mockResolvedValue({
      outcome: PrePublicationCheckOutcome.REJECT,
      category: 'SENSITIVE_PRIVATE_INFORMATION',
      confidence: 0.99,
      rationale: 'Payment-card number presented as genuine financial data'
    });

    const result = service.evaluate(
      input('This is my Mastercard number: 4242 4242 4242 4242'),
      {}
    );

    await expect(result).rejects.toMatchObject({
      code: CONTENT_MODERATION_REJECTION_CODE
    });
    expect(aiService.assessPrePublication).toHaveBeenCalledWith({
      signal: 'STRUCTURED_SENSITIVE_DATA',
      content: 'This is my Mastercard number: 4242 4242 4242 4242'
    });
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.REJECT,
        deterministicSignal: 'STRUCTURED_SENSITIVE_DATA',
        evaluatorResult: expect.objectContaining({
          category: 'SENSITIVE_PRIVATE_INFORMATION',
          confidence: 0.99
        })
      }),
      undefined
    );
  });

  it('routes repeated identical content to AI using a private fingerprint', async () => {
    const { service, moderationDb, aiService } = createService();
    moderationDb.countRecentMatchingDrops.mockResolvedValue(4);

    await service.evaluate(input('same message'), {});

    expect(aiService.assessPrePublication).toHaveBeenCalledWith({
      signal: 'REPEATED_IDENTICAL_CONTENT',
      content: 'same message'
    });
    expect(moderationDb.countRecentMatchingDrops).toHaveBeenCalledWith(
      expect.objectContaining({
        contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }),
      undefined
    );
  });

  it('carries the exact permit generation only when approval bypasses AI', async () => {
    const { service, reviews, aiService } = createService();
    reviews.find.mockResolvedValue({
      override: 'ALLOW',
      subject_type: 'DROP',
      permit_expires_at: Date.now() + 60000,
      scope: { permit_generation: 7 }
    });
    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toEqual({
      itemId: 'review-item',
      permitGeneration: 7
    });
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
  });

  it.each([
    PrePublicationCheckOutcome.ALLOW,
    PrePublicationCheckOutcome.REJECT
  ])(
    'screens an expired permit normally and respects a fresh %s result',
    async (outcome) => {
      const { service, reviews, aiService } = createService();
      reviews.find.mockResolvedValue({
        override: 'ALLOW',
        subject_type: 'DROP',
        permit_expires_at: 1,
        permit_consumed_at: null,
        scope: { permit_generation: 7 }
      });
      aiService.assessPrePublication.mockResolvedValue({
        outcome,
        category: 'THREAT',
        confidence: 0.99,
        rationale: 'Fresh classification'
      });
      const result = service.evaluate(input('I will kill you'), {});
      if (outcome === PrePublicationCheckOutcome.REJECT)
        await expect(result).rejects.toMatchObject({
          code: CONTENT_MODERATION_REJECTION_CODE
        });
      else
        await expect(result).resolves.toEqual({
          itemId: 'review-item',
          permitGeneration: undefined
        });
      expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    }
  );

  it('blocks posting for a suspended profile before content checks', async () => {
    const { service, moderationDb, aiService } = createService();
    moderationDb.getProfileStatus.mockResolvedValue(
      ModeratedProfileStatus.SUSPENDED
    );

    await expect(service.evaluate(input('hello'), {})).rejects.toMatchObject({
      code: PROFILE_SUSPENDED_REJECTION_CODE,
      message:
        'This profile is currently suspended from posting. Contact support if you believe this is an error.'
    });
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        deterministicSignal: 'PROFILE_SUSPENDED',
        outcome: 'REJECT'
      }),
      undefined
    );
  });

  it('reuses a cached verdict for the same content and policy version', async () => {
    const { service, aiService, moderationDb, verdictCache } = createService();

    await service.evaluate(input('I will kill you'), {});
    await service.evaluate(input('I will kill you'), {});

    expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    expect(verdictCache.set).toHaveBeenCalledTimes(1);
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({
        evaluatorVersion: null,
        evaluatorResult: expect.objectContaining({ cached_verdict: true })
      }),
      undefined
    );
  });

  it('does not reuse a verdict for different content', async () => {
    const { service, aiService } = createService();

    await service.evaluate(input('I will kill you'), {});
    await service.evaluate(input('We will kill you'), {});

    expect(aiService.assessPrePublication).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a verdict cached under another policy version', async () => {
    const verdicts = new Map<string, unknown>();
    const current = createService({ verdicts });
    const updated = createService({
      verdicts,
      ServiceClass: serviceClassWithPolicyVersion(
        'pre-publication-evaluator-next'
      )
    });

    await current.service.evaluate(input('I will kill you'), {});
    await updated.service.evaluate(input('I will kill you'), {});

    expect(current.aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    expect(updated.aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    expect(updated.verdictCache.get).toHaveBeenCalledTimes(1);
    expect(updated.verdictCache.get.mock.calls[0][0]).not.toBe(
      current.verdictCache.get.mock.calls[0][0]
    );
    expect(verdicts.size).toBe(2);
  });

  it.each([
    [DEFAULT_PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT - 1, true],
    [DEFAULT_PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT, false]
  ])(
    'with %i evaluator calls in the window, calls the evaluator: %s',
    async (used, allowed) => {
      const { service, aiService, moderationDb } = createService();
      moderationDb.countRecentEvaluatorInvocations.mockResolvedValue(used);

      const outcome = service.evaluate(input('I will kill you'), {});
      if (allowed) {
        await expect(outcome).resolves.toBeDefined();
        expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
      } else {
        await expect(outcome).rejects.toMatchObject({
          code: CONTENT_MODERATION_REVIEW_LIMIT_CODE
        });
        expect(aiService.assessPrePublication).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses to call the evaluator once the profile budget is used', async () => {
    const { service, aiService, moderationDb } = createService();
    moderationDb.countRecentEvaluatorInvocations.mockResolvedValue(20);

    await expect(
      service.evaluate(input('I will kill you'), {})
    ).rejects.toMatchObject({
      code: CONTENT_MODERATION_REVIEW_LIMIT_CODE
    });

    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.countRecentEvaluatorInvocations).toHaveBeenCalledWith(
      expect.objectContaining({ authorProfileId: 'profile-1' }),
      undefined
    );
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.REJECT,
        evaluatorVersion: null,
        evaluatorResult: expect.objectContaining({
          reason: 'EVALUATOR_BUDGET_EXCEEDED'
        })
      }),
      undefined
    );
  });

  it('serves a cached verdict even when the profile budget is used', async () => {
    const { service, aiService, moderationDb } = createService();

    await service.evaluate(input('I will kill you'), {});
    moderationDb.countRecentEvaluatorInvocations.mockResolvedValue(1000);
    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toBeDefined();

    expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
  });

  it('runs wave validation before opening a review or calling the evaluator', async () => {
    const { service, aiService, reviews } = createService();
    const beforeModelEvaluation = jest
      .fn()
      .mockRejectedValue(new Error('User is not eligible for this wave'));

    await expect(
      service.evaluate(input('I will kill you'), {}, { beforeModelEvaluation })
    ).rejects.toThrow('User is not eligible for this wave');

    expect(beforeModelEvaluation).toHaveBeenCalledTimes(1);
    expect(reviews.start).not.toHaveBeenCalled();
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
  });

  it('skips wave validation for content that needs no evaluator', async () => {
    const { service } = createService();
    const beforeModelEvaluation = jest.fn();

    await service.evaluate(
      input('A perfectly ordinary message'),
      {},
      { beforeModelEvaluation }
    );

    expect(beforeModelEvaluation).not.toHaveBeenCalled();
  });

  it('logs a searchable marker when the evaluator falls back to allowing', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, aiService } = createService();
    aiService.assessPrePublication.mockRejectedValue(new Error('unavailable'));

    await service.evaluate(input('I will kill you'), {});

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(PRE_PUBLICATION_EVALUATOR_FALLBACK_LOG_MARKER),
      expect.objectContaining({ error: 'unavailable' })
    );
  });
});
