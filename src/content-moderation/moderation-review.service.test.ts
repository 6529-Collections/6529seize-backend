import { mock } from 'ts-jest-mocker';
import { AuthenticationContext } from '@/auth-context';
import { env } from '@/env';
import { ModeratedProfileStatus } from '@/entities/IContentModeration';
import { contentModerationDb } from './content-moderation.db';
import { ModerationReviewDb } from './moderation-review.db';
import {
  ModerationReviewService,
  itemSummary
} from './moderation-review.service';
import {
  ModerationItem,
  moderationFingerprint,
  moderationItemId
} from './moderation-review.types';

const revision = 'reviewed-revision';
function item(): ModerationItem {
  return {
    id: 'item',
    subject_type: 'PROFILE_BIO',
    subject_id: 'author',
    author_profile_id: 'author',
    actor_profile_id: 'author',
    operation: 'UPDATE',
    policy_family: 'PUBLIC_FIELDS',
    policy_version: 'policy',
    scope: { current_revision: revision },
    evidence: { text: 'rejected draft' },
    content_fingerprint: 'fingerprint',
    outcome: 'REJECT',
    trigger: 'PUBLIC_FIELD',
    review_status: 'NEEDS_REVIEW',
    override: null,
    permit_expires_at: null,
    permit_consumed_at: null,
    published_subject_id: null,
    suppressed: false,
    version: 3,
    created_at: 1,
    updated_at: 2,
    evidence_expires_at: null
  };
}
describe('Developer review guards and evidence', () => {
  let db: ModerationReviewDb;
  let service: ModerationReviewService;
  let record: ModerationItem;
  const ctx = () => ({
    authenticationContext: AuthenticationContext.fromProfileId('dev')
  });
  beforeEach(() => {
    db = mock();
    record = item();
    service = new ModerationReviewService(db);
    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((name) =>
        name === 'DEVS_6529_MENTION_PROFILE_IDS' ? ['dev'] : ['other']
      );
    jest.mocked(db.get).mockImplementation(async () => record);
    jest.mocked(db.history).mockResolvedValue({ evaluations: [], audit: [] });
    jest.mocked(db.currentRevision).mockResolvedValue(revision);
    jest
      .mocked(db.executeNativeQueriesInTransaction)
      .mockImplementation((run) => run({ connection: {} }));
    jest
      .spyOn(contentModerationDb, 'getProfileStatus')
      .mockResolvedValue(ModeratedProfileStatus.ACTIVE);
  });
  afterEach(() => jest.restoreAllMocks());
  const action = {
    action: 'ALLOW' as const,
    reason: 'Reviewed exact content',
    expected_version: 3,
    idempotency_key: '31d02eeb-7616-46f2-963e-cbf5a4c41e8e'
  };
  it('denies broad moderator identities before reading evidence', async () => {
    await expect(
      service.detail('item', {
        authenticationContext: AuthenticationContext.fromProfileId('other')
      })
    ).rejects.toThrow('Developer access');
    expect(db.get).not.toHaveBeenCalled();
  });
  it('denies developers acting through a proxy', async () => {
    const request = ctx();
    jest
      .spyOn(request.authenticationContext, 'isAuthenticatedAsProxy')
      .mockReturnValue(true);
    await expect(service.detail('item', request)).rejects.toThrow(
      'Developer access'
    );
    expect(db.get).not.toHaveBeenCalled();
  });
  it('issues an exact resubmission decision without writing archived draft content', async () => {
    const result = await service.action('item', action, ctx());
    expect(result.action_effect).toBe('EXACT_RESUBMISSION_PERMIT');
    expect(db.decide).toHaveBeenCalledWith(record, 'ALLOW', expect.anything());
    expect(db.consume).not.toHaveBeenCalled();
    expect(db.audit).toHaveBeenCalledWith(
      record,
      expect.objectContaining({
        actor: 'dev',
        action: 'ALLOW',
        reason: action.reason
      }),
      expect.anything()
    );
  });
  it('rejects stale review versions before mutation', async () => {
    await expect(
      service.action('item', { ...action, expected_version: 2 }, ctx())
    ).rejects.toThrow('Refresh');
    expect(db.decide).not.toHaveBeenCalled();
  });
  it('rejects an approval after the author changes the target field', async () => {
    jest.mocked(db.currentRevision).mockResolvedValue('later-revision');
    await expect(service.action('item', action, ctx())).rejects.toThrow(
      'unavailable'
    );
    expect(db.decide).not.toHaveBeenCalled();
  });
  it('rejects a valid enum action that does not apply to the current subject', async () => {
    await expect(
      service.action('item', { ...action, action: 'REMOVE' }, ctx())
    ).rejects.toThrow('unavailable');
    expect(db.decide).not.toHaveBeenCalled();
  });
  it('makes repeated identical action keys idempotent', async () => {
    jest.mocked(db.priorAction).mockResolvedValue({
      item_id: 'item',
      actor_profile_id: 'dev',
      action: 'ALLOW',
      reason: action.reason
    });
    await service.action('item', action, ctx());
    expect(db.decide).not.toHaveBeenCalled();
    expect(db.audit).not.toHaveBeenCalled();
  });
  it('expires preview and snapshot together and disables content actions', async () => {
    record.evidence_expires_at = 1;
    expect(itemSummary(record).preview).toBeNull();
    const result = await service.detail('item', ctx());
    expect(result.evidence).toBeNull();
    expect(result.allowed_actions).not.toContain('ALLOW');
    expect(result.allowed_actions).not.toContain('REEVALUATE');
  });
  it.each(['PROFILE_BIO', 'GROUP_NAME'] as const)(
    'restores a current suppressed %s after evidence deletion without recreating it',
    async (subject) => {
      record.subject_type = subject;
      record.published_subject_id = 'published';
      record.scope.published_revision = revision;
      record.suppressed = true;
      record.evidence = null;
      record.evidence_expires_at = 1;
      const detail = await service.detail('item', ctx());
      expect(detail.allowed_actions).toEqual(['MARK_REVIEWED', 'RESTORE']);
      expect(detail.evidence).toBeNull();
      await service.action('item', { ...action, action: 'RESTORE' }, ctx());
      expect(db.decide).toHaveBeenCalledWith(
        record,
        'RESTORE',
        expect.anything()
      );
      expect(db.audit).toHaveBeenCalledWith(
        record,
        expect.objectContaining({ actor: 'dev', action: 'RESTORE' }),
        expect.anything()
      );
      expect(record.evidence).toBeNull();
      expect(db.start).not.toHaveBeenCalled();
    }
  );
  it.each(['PROFILE_BIO', 'GROUP_NAME'] as const)(
    'rejects expired %s restoration after its published revision changes',
    async (subject) => {
      record.subject_type = subject;
      record.published_subject_id = 'published';
      record.scope.published_revision = revision;
      record.suppressed = true;
      record.evidence = null;
      record.evidence_expires_at = 1;
      jest.mocked(db.currentRevision).mockResolvedValue('later-revision');
      const detail = await service.detail('item', ctx());
      expect(detail.allowed_actions).toEqual(['MARK_REVIEWED']);
      await expect(
        service.action('item', { ...action, action: 'RESTORE' }, ctx())
      ).rejects.toThrow('unavailable');
      expect(db.decide).not.toHaveBeenCalled();
    }
  );
  it('requires an explicit published revision and current suppression for expired restoration', async () => {
    record.published_subject_id = 'published';
    record.suppressed = true;
    record.evidence = null;
    record.evidence_expires_at = 1;
    expect((await service.detail('item', ctx())).allowed_actions).toEqual([
      'MARK_REVIEWED'
    ]);
    record.scope.published_revision = revision;
    record.suppressed = false;
    expect((await service.detail('item', ctx())).allowed_actions).toEqual([
      'MARK_REVIEWED'
    ]);
  });
  it('exposes an opaque REP subject ID even after evidence expires', async () => {
    record.subject_type = 'REP_CATEGORY';
    record.subject_id = 'Private category text?';
    record.evidence = { text: record.subject_id };
    expect(itemSummary(record).subject_id).toBe(record.id);
    record.evidence_expires_at = 1;
    const result = await service.detail('item', ctx());
    expect(result.check.subject_id).toBe(record.id);
    expect(JSON.stringify(result)).not.toContain('Private category text?');
  });
  it('keeps expired historical report markers unavailable for content actions', async () => {
    record.evidence = { evidence_expired: true };
    record.operation = 'REPORT';
    const result = await service.detail('item', ctx());
    expect(result.evidence_expired).toBe(true);
    expect(result.evidence).toBeNull();
    expect(result.allowed_actions).toEqual(['MARK_REVIEWED']);
  });
  it('hashes objects identically after MySQL JSON key ordering and keeps policy upgrades on the same item', () => {
    expect(moderationFingerprint({ a: 1, b: 2 })).toBe(
      moderationFingerprint({ b: 2, a: 1 })
    );
    const input = { ...record, evidence: record.evidence! };
    expect(moderationItemId(input)).toBe(
      moderationItemId({
        ...input,
        actor_profile_id: 'another-delegate',
        policy_version: 'new-policy',
        scope: {
          published_revision: 'saved',
          acting_as_profile_id: 'author',
          ...input.scope
        }
      })
    );
  });
});
