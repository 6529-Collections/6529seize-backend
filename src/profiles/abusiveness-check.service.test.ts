import { mock } from 'ts-jest-mocker';
import { AuthenticationContext } from '@/auth-context';
import { AbusivenessCheckService } from './abusiveness-check.service';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { AiBasedAbusivenessDetector } from '@/abusiveness/ai-based-abusiveness.detector';
import { ModerationReviewDb } from '@/content-moderation/moderation-review.db';
import { ModerationItem } from '@/content-moderation/moderation-review.types';
import {
  PUBLIC_TEXT_POLICY_VERSION,
  publicTextModel
} from '@/content-moderation/moderation-review.service';

describe('AbusivenessCheckService durable moderation', () => {
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
    cache = mock();
    detector = mock();
    reviews = mock();
    jest.mocked(reviews.start).mockResolvedValue({
      item: { id: 'item', override: null } as ModerationItem,
      evaluationId: 'evaluation'
    });
    jest.mocked(detector.checkRepPhraseText).mockResolvedValue(allowed);
    service = new AbusivenessCheckService(detector, cache, reviews);
  });
  it('records the authenticated proxy actor separately from the effective profile', async () => {
    await service.checkRepPhrase('Builder', {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'delegate',
        roleProfileId: 'author',
        activeProxyActions: []
      })
    });
    expect(reviews.start).toHaveBeenCalledWith(
      expect.objectContaining({
        author_profile_id: null,
        actor_profile_id: 'delegate',
        scope: { acting_as_profile_id: 'author' }
      }),
      'PUBLIC_FIELD'
    );
  });
  it.each(['', ' '.repeat(2), 'r'.repeat(101)])(
    'retains REP length validation',
    async (text) => {
      await expect(service.checkRepPhrase(text)).rejects.toThrow(
        'Text must be 1-100 characters'
      );
      expect(reviews.start).not.toHaveBeenCalled();
    }
  );
  it.each(['Hey\nyou', 'Hey\tyou', 'Hey%you'])(
    'retains REP character validation',
    async (text) => {
      await expect(service.checkRepPhrase(text)).rejects.toThrow(
        'invalid characters'
      );
    }
  );
  it('captures normalized Unicode text before calling the classifier', async () => {
    await service.checkRepPhrase('  建設者 реп 123  ');
    expect(reviews.start).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: { text: '建設者 реп 123' },
        policy_family: 'PUBLIC_FIELDS'
      }),
      'PUBLIC_FIELD'
    );
    expect(jest.mocked(reviews.start).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(detector.checkRepPhraseText).mock.invocationCallOrder[0]!
    );
    expect(cache.saveVersionedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        policy_version: PUBLIC_TEXT_POLICY_VERSION,
        model: publicTextModel()
      })
    );
  });
  it('records a matching cache hit as a separate evaluation', async () => {
    jest.mocked(cache.findResult).mockResolvedValue({
      ...allowed,
      policy_version: PUBLIC_TEXT_POLICY_VERSION,
      model: publicTextModel()
    });
    await service.checkRepPhrase('Builder');
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
    expect(reviews.finish).toHaveBeenCalledWith(
      'evaluation',
      expect.objectContaining({ outcome: 'ALLOW', cacheHit: true })
    );
  });
  it('reevaluates legacy unversioned cache rows', async () => {
    jest.mocked(cache.findResult).mockResolvedValue({ ...allowed });
    await service.checkRepPhrase('Builder');
    expect(detector.checkRepPhraseText).toHaveBeenCalledWith('Builder');
  });
  it('preserves a developer block across model changes', async () => {
    jest.mocked(reviews.start).mockResolvedValue({
      item: { id: 'item', override: 'BLOCK' } as ModerationItem,
      evaluationId: 'evaluation'
    });
    await expect(service.checkRepPhrase('Builder')).resolves.toMatchObject({
      status: 'DISALLOWED'
    });
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
  });
  it('retains single REP model-failure allowance with a durable failure marker', async () => {
    jest
      .mocked(detector.checkRepPhraseText)
      .mockRejectedValue(new Error('private provider response'));
    await expect(service.checkRepPhrase('Builder')).resolves.toMatchObject({
      status: 'ALLOWED'
    });
    expect(reviews.finish).toHaveBeenCalledWith(
      'evaluation',
      expect.objectContaining({
        fallback: 'ALLOW',
        result: { error: 'EVALUATOR_UNAVAILABLE' }
      })
    );
  });
  it('fails before AI when durable capture is unavailable', async () => {
    jest
      .mocked(reviews.start)
      .mockRejectedValue(new Error('storage unavailable'));
    await expect(service.checkRepPhrase('Builder')).rejects.toThrow(
      'storage unavailable'
    );
    expect(detector.checkRepPhraseText).not.toHaveBeenCalled();
  });
  it('does not reinterpret persistence failure as model failure', async () => {
    jest
      .mocked(reviews.finish)
      .mockRejectedValue(new Error('storage unavailable'));
    await expect(service.checkRepPhrase('Builder')).rejects.toThrow(
      'storage unavailable'
    );
    expect(reviews.finish).toHaveBeenCalledTimes(1);
  });
  it('records known safe group names without requesting AI', async () => {
    await expect(
      service.checkFilterName({
        text: 'Only Me',
        handle: 'alice',
        profile_id: 'profile-alice',
        group_id: 'group'
      })
    ).resolves.toMatchObject({ status: 'ALLOWED' });
    expect(detector.checkUserGroupName).not.toHaveBeenCalled();
    expect(reviews.finish).toHaveBeenCalledWith(
      'evaluation',
      expect.objectContaining({ model: null })
    );
  });
  it('keeps BIO evaluator errors blocking and distinct from rejection', async () => {
    jest
      .mocked(detector.checkBioText)
      .mockRejectedValue(new Error('private provider response'));
    await expect(
      service.checkBio({
        text: 'bio',
        handle: 'alice',
        profile_id: 'profile-alice',
        profile_type: 'PSEUDONYM'
      })
    ).rejects.toThrow('temporarily unavailable');
    expect(reviews.finish).toHaveBeenCalledWith(
      'evaluation',
      expect.objectContaining({ outcome: 'ERROR', fallback: 'REQUEST_FAILED' })
    );
  });
  it('carries the approval generation when a BIO permit bypasses the classifier', async () => {
    jest.mocked(reviews.start).mockResolvedValue({
      item: {
        id: 'item',
        subject_type: 'PROFILE_BIO',
        override: 'ALLOW',
        scope: { permit_generation: 7 },
        permit_expires_at: Date.now() + 60000
      } as unknown as ModerationItem,
      evaluationId: 'evaluation'
    });
    const result = await service.checkBio({
      text: 'bio',
      handle: 'alice',
      profile_id: 'profile-alice',
      profile_type: 'PSEUDONYM'
    });
    expect(result.moderation_permit_generation).toBe(7);
    expect(detector.checkBioText).not.toHaveBeenCalled();
  });
  it('requires stable profile IDs before capturing BIO or group moderation', async () => {
    await expect(
      service.checkBio({
        text: 'bio',
        handle: 'alice',
        profile_type: 'PSEUDONYM',
        profile_id: ''
      })
    ).rejects.toThrow('Profile ID is required');
    await expect(
      service.checkFilterName({
        text: 'Only Me',
        handle: 'alice',
        profile_id: ''
      })
    ).rejects.toThrow('Profile ID is required');
    expect(reviews.start).not.toHaveBeenCalled();
  });
});
