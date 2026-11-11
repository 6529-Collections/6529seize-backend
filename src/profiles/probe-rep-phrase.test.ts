import { mock } from 'ts-jest-mocker';
import { redisGet, redisSetJson } from '@/redis';
import { AbusivenessCheckService } from './abusiveness-check.service';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { AiBasedAbusivenessDetector } from '@/abusiveness/ai-based-abusiveness.detector';
import { ModerationReviewDb } from '@/content-moderation/moderation-review.db';
import { ModerationItem } from '@/content-moderation/moderation-review.types';
import {
  PUBLIC_TEXT_POLICY_VERSION,
  publicTextModel
} from '@/content-moderation/moderation-review.service';

jest.mock('@/redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

describe('AbusivenessCheckService.probeRepPhrase', () => {
  const allowed = {
    text: 'Builder',
    status: 'ALLOWED',
    explanation: null,
    external_check_performed_at: new Date(0)
  } as const;
  let cache: AbusivenessCheckDb;
  let detector: AiBasedAbusivenessDetector;
  let reviews: ModerationReviewDb;
  let service: AbusivenessCheckService;

  beforeEach(() => {
    jest.mocked(redisGet).mockReset().mockResolvedValue(null);
    jest.mocked(redisSetJson).mockReset().mockResolvedValue();
    cache = mock();
    detector = mock();
    reviews = mock();
    jest.mocked(reviews.find).mockResolvedValue(null);
    jest.mocked(cache.findResult).mockResolvedValue(null);
    jest.mocked(detector.checkRepPhraseText).mockResolvedValue(allowed);
    service = new AbusivenessCheckService(detector, cache, reviews);
  });

  function expectNoPersistentWrites() {
    expect(reviews.start).not.toHaveBeenCalled();
    expect(reviews.finish).not.toHaveBeenCalled();
    expect(cache.saveVersionedResult).not.toHaveBeenCalled();
  }

  it('classifies a new phrase without writing moderation rows or suggestions', async () => {
    await expect(service.probeRepPhrase('  Builder ')).resolves.toMatchObject({
      status: 'ALLOWED'
    });
    expect(detector.checkRepPhraseText).toHaveBeenCalledWith('Builder');
    expectNoPersistentWrites();
    expect(redisSetJson).toHaveBeenCalledWith(
      expect.stringMatching(/^rep-category-probe:[0-9a-f]{64}$/),
      allowed,
      expect.anything()
    );
  });

  it('reuses a probe result from Redis without calling the classifier', async () => {
    jest.mocked(redisGet).mockResolvedValue({
      ...allowed,
      status: 'DISALLOWED'
    });
    await expect(service.probeRepPhrase('Builder')).resolves.toMatchObject({
      status: 'DISALLOWED'
    });
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
    expectNoPersistentWrites();
  });

  it('answers from a current stored result', async () => {
    jest.mocked(cache.findResult).mockResolvedValue({
      ...allowed,
      policy_version: PUBLIC_TEXT_POLICY_VERSION,
      model: publicTextModel()
    });
    await expect(service.probeRepPhrase('Builder')).resolves.toMatchObject({
      status: 'ALLOWED'
    });
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
    expectNoPersistentWrites();
  });

  it('honours a developer block', async () => {
    jest
      .mocked(reviews.find)
      .mockResolvedValue({ id: 'item', override: 'BLOCK' } as ModerationItem);
    await expect(service.probeRepPhrase('Builder')).resolves.toMatchObject({
      status: 'DISALLOWED'
    });
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
    expectNoPersistentWrites();
  });

  it('allows the phrase when the classifier is unavailable, without writes', async () => {
    jest
      .mocked(detector.checkRepPhraseText)
      .mockRejectedValue(new Error('unavailable'));
    await expect(service.probeRepPhrase('Builder')).resolves.toMatchObject({
      status: 'ALLOWED'
    });
    expectNoPersistentWrites();
    expect(redisSetJson).not.toHaveBeenCalled();
  });

  it('keeps the REP text validation', async () => {
    await expect(service.probeRepPhrase('r'.repeat(101))).rejects.toThrow(
      'Text must be 1-100 characters'
    );
    await expect(service.probeRepPhrase('Hey%you')).rejects.toThrow(
      'invalid characters'
    );
    expect(reviews.find).not.toHaveBeenCalled();
  });

  it('still records rating checks durably', async () => {
    jest.mocked(reviews.start).mockResolvedValue({
      item: { id: 'item', override: null } as ModerationItem,
      evaluationId: 'evaluation'
    });
    await service.checkRepPhrase('Builder');
    expect(reviews.start).toHaveBeenCalled();
    expect(cache.saveVersionedResult).toHaveBeenCalled();
  });
});
