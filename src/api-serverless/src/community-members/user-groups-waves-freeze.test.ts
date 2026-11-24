import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import {
  WAVES_FROZEN_GROUP_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';

const FLAG = 'FEATURE_WAVES_FROZEN';
const PAST_FREEZE = new Error('past the waves freeze check');

function createService() {
  const userGroupsDb = {
    getAllWaveRelatedGroups: jest
      .fn()
      .mockResolvedValue(['wave-admin-group', 'decision-vote-group']),
    executeNativeQueriesInTransaction: jest.fn(
      (work: (connection: unknown) => Promise<unknown>) => work({})
    ),
    findVisibilityRequest: jest.fn().mockResolvedValue(null),
    reserveVisibilityRequest: jest.fn().mockResolvedValue(false),
    lockForVisibilityChange: jest.fn().mockResolvedValue(undefined),
    completeVisibilityRequest: jest.fn().mockResolvedValue(undefined)
  };
  const service = new UserGroupsService(
    userGroupsDb as any,
    {} as any,
    {} as any,
    {} as any
  );
  jest.spyOn(service, 'getByIdOrThrow').mockRejectedValue(PAST_FREEZE);
  return { service, userGroupsDb };
}

function change(old_version_id: string | null, idempotencyKey?: string) {
  return {
    group_id: 'new-version',
    old_version_id,
    visible: true,
    profile_id: 'creator',
    idempotencyKey
  } as any;
}

describe('group replacement during the waves freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
    jest.restoreAllMocks();
  });

  it.each(['wave-admin-group', 'decision-vote-group'])(
    'replaces no group a wave or decision uses (%s) while frozen',
    async (oldVersion) => {
      process.env[FLAG] = 'true';
      const { service, userGroupsDb } = createService();
      const result = service.changeVisibility(change(oldVersion), {});
      await expect(result).rejects.toBeInstanceOf(WavesFrozenException);
      await expect(result).rejects.toThrow(WAVES_FROZEN_GROUP_MESSAGE);
      expect(
        userGroupsDb.executeNativeQueriesInTransaction
      ).not.toHaveBeenCalled();
    }
  );

  it('reads the receipt and writes none when it refuses a request with an Idempotency-Key', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue(null);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'new-key'), {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(userGroupsDb.findVisibilityRequest).toHaveBeenCalledTimes(1);
    expect(userGroupsDb.reserveVisibilityRequest).not.toHaveBeenCalled();
    expect(
      userGroupsDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('answers a retry of a save that finished before the freeze from its receipt', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    const stored = { id: 'wave-admin-group' } as any;
    userGroupsDb.findVisibilityRequest.mockResolvedValue({
      payload_hash: 'saved',
      completed: true
    });
    userGroupsDb.reserveVisibilityRequest.mockResolvedValue(true);
    jest.mocked(service.getByIdOrThrow).mockResolvedValue(stored);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'saved-key'), {})
    ).resolves.toBe(stored);
    expect(userGroupsDb.lockForVisibilityChange).not.toHaveBeenCalled();
  });

  it('answers a retry of a save with a receipt from before Idempotency-Key receipts', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    const stored = { id: 'wave-admin-group' } as any;
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue({
      scope: {
        save_subject_id: 'new-version',
        old_version_id: 'wave-admin-group',
        visible: true
      },
      published_subject_id: 'wave-admin-group'
    } as any);
    jest.mocked(service.getByIdOrThrow).mockResolvedValue(stored);
    await expect(
      service.changeVisibility(change('wave-admin-group', 'legacy-key'), {})
    ).resolves.toBe(stored);
    expect(userGroupsDb.completeVisibilityRequest).toHaveBeenCalledTimes(1);
  });

  it('still replaces a group no wave uses, and publishes new groups', async () => {
    process.env[FLAG] = 'true';
    const { service, userGroupsDb } = createService();
    await expect(
      service.changeVisibility(change('filter-group'), {})
    ).rejects.toBe(PAST_FREEZE);
    await expect(service.changeVisibility(change(null), {})).rejects.toBe(
      PAST_FREEZE
    );
    expect(userGroupsDb.getAllWaveRelatedGroups).toHaveBeenCalledTimes(1);
  });

  it('replaces groups as before when not frozen', async () => {
    delete process.env[FLAG];
    const { service, userGroupsDb } = createService();
    await expect(
      service.changeVisibility(change('wave-admin-group'), {})
    ).rejects.toBe(PAST_FREEZE);
    expect(userGroupsDb.getAllWaveRelatedGroups).not.toHaveBeenCalled();
  });
});
