import {
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { PrePublicationModerationService } from './pre-publication-moderation.service';

function createService() {
  const moderationDb = {
    getProfileStatus: jest
      .fn()
      .mockResolvedValue(ModeratedProfileStatus.ACTIVE),
    countRecentMatchingDrops: jest.fn().mockResolvedValue(0),
    recordPrePublicationCheck: jest.fn().mockResolvedValue(undefined)
  };
  const aiService = {
    assessPrePublication: jest.fn().mockResolvedValue({
      outcome: PrePublicationCheckOutcome.ALLOW,
      category: 'NONE',
      confidence: 0.2,
      rationale: 'Allowed'
    })
  };
  return {
    service: new PrePublicationModerationService(
      moderationDb as any,
      aiService as any
    ),
    moderationDb,
    aiService
  };
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
    process.env.CONTENT_MODERATION_BLOCKED_HOSTS = originalBlockedHosts;
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
        signal: null,
        evaluatorVersion: null,
        contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
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
      message: expect.stringContaining('known unsafe destination')
    });
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.REJECT,
        signal: 'KNOWN_MALICIOUS_DESTINATION',
        evaluatorVersion: null
      })
    );
  });

  it('allows an uncertain AI result after a narrow deterministic signal', async () => {
    const { service, moderationDb, aiService } = createService();
    aiService.assessPrePublication.mockResolvedValue({
      outcome: PrePublicationCheckOutcome.REJECT,
      category: 'CREDIBLE_THREAT',
      confidence: 0.94,
      rationale: 'Not certain enough'
    });

    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toBeUndefined();

    expect(aiService.assessPrePublication).toHaveBeenCalledTimes(1);
    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.ALLOW,
        signal: 'EXPLICIT_THREAT_PATTERN',
        evaluatorVersion: expect.any(String)
      })
    );
  });

  it('rejects only a high-confidence explicit AI violation', async () => {
    const { service, aiService } = createService();
    aiService.assessPrePublication.mockResolvedValue({
      outcome: PrePublicationCheckOutcome.REJECT,
      category: 'CREDIBLE_THREAT',
      confidence: 0.99,
      rationale: 'Explicit threat'
    });

    const result = service.evaluate(input('I will kill you'), {});

    await expect(result).rejects.toBeInstanceOf(CustomApiCompliantException);
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining('credible threat')
    });
  });

  it('fails open when the AI evaluator is unavailable', async () => {
    const { service, moderationDb, aiService } = createService();
    aiService.assessPrePublication.mockRejectedValue(new Error('unavailable'));

    await expect(
      service.evaluate(input('I will kill you'), {})
    ).resolves.toBeUndefined();

    expect(moderationDb.recordPrePublicationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PrePublicationCheckOutcome.ALLOW,
        evaluatorResult: expect.objectContaining({ evaluator_error: true })
      })
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

  it('blocks posting for a suspended profile before content checks', async () => {
    const { service, moderationDb, aiService } = createService();
    moderationDb.getProfileStatus.mockResolvedValue(
      ModeratedProfileStatus.SUSPENDED
    );

    await expect(service.evaluate(input('hello'), {})).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(aiService.assessPrePublication).not.toHaveBeenCalled();
    expect(moderationDb.recordPrePublicationCheck).not.toHaveBeenCalled();
  });
});
