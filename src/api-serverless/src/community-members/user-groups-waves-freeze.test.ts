import { UserGroupsService } from '@/api/community-members/user-groups.service';
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
    reserveVisibilityRequest: jest.fn().mockResolvedValue(false),
    lockForVisibilityChange: jest.fn().mockResolvedValue(undefined)
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

function change(old_version_id: string | null) {
  return {
    group_id: 'new-version',
    old_version_id,
    visible: true,
    profile_id: 'creator'
  } as any;
}

describe('group replacement during the waves freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
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
