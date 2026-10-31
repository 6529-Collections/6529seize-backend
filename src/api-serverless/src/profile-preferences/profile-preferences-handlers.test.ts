const mockGetPreferences = jest.fn();
const mockUpsertPreferences = jest.fn();
const mockIsGroupUsable = jest.fn();
const mockVisibleGroups = jest.fn();
const mockAuthenticationContext = {
  getActingAsId: jest.fn(() => 'profile-1'),
  isAuthenticatedAsProxy: jest.fn(() => false)
};

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(async () => mockAuthenticationContext)
}));

jest.mock('@/profile-preferences/profile-preferences.db', () => ({
  profilePreferencesDb: {
    get: mockGetPreferences,
    upsert: mockUpsertPreferences
  }
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    directMessageAdmission: { isGroupUsable: mockIsGroupUsable },
    getApiGroupsVisibleToRequesterByIds: mockVisibleGroups
  }
}));

import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileDirectMessagePolicy,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import { BadRequestException } from '@/exceptions';
import {
  handleGetProfilePreferences,
  handlePutProfilePreferences
} from './profile-preferences.handlers';

type PutRequest = Parameters<typeof handlePutProfilePreferences>[0];
type GetRequest = Parameters<typeof handleGetProfilePreferences>[0];

function stored(
  overrides: Partial<ProfilePreferencesData> = {}
): ProfilePreferencesData {
  return { ...DEFAULT_PROFILE_PREFERENCES, ...overrides };
}

function put(body: unknown) {
  return handlePutProfilePreferences({ body } as unknown as PutRequest);
}

describe('profile preferences handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPreferences.mockResolvedValue(stored());
    mockUpsertPreferences.mockImplementation(async (_id, update) =>
      stored(update)
    );
    mockIsGroupUsable.mockResolvedValue(true);
    mockVisibleGroups.mockResolvedValue([
      { id: 'group-1', is_direct_message: false }
    ]);
  });

  it('returns the legacy defaults with the new additive fields', async () => {
    await expect(
      handleGetProfilePreferences({} as unknown as GetRequest)
    ).resolves.toEqual({
      direct_message_policy: 'EVERYONE',
      direct_message_group_id: null,
      direct_message_allow_people_i_follow: true,
      direct_message_group_unavailable: false,
      notification_level: 'ALL',
      notifications: DEFAULT_PROFILE_PREFERENCES.notifications
    });
    expect(mockIsGroupUsable).not.toHaveBeenCalled();
  });

  it('reports an unusable chosen group so settings can warn', async () => {
    mockGetPreferences.mockResolvedValue(
      stored({
        direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
        direct_message_group_id: 'deleted-group'
      })
    );
    mockIsGroupUsable.mockResolvedValue(false);

    await expect(
      handleGetProfilePreferences({} as unknown as GetRequest)
    ).resolves.toMatchObject({
      direct_message_policy: 'GROUP_MEMBERS',
      direct_message_group_id: 'deleted-group',
      direct_message_group_unavailable: true
    });
    expect(mockIsGroupUsable).toHaveBeenCalledWith('deleted-group', {
      timer: undefined
    });
  });

  it('saves the group policy with a group the profile can see', async () => {
    await expect(
      put({
        direct_message_policy: 'GROUP_MEMBERS',
        direct_message_group_id: 'group-1',
        direct_message_allow_people_i_follow: false
      })
    ).resolves.toMatchObject({
      direct_message_policy: 'GROUP_MEMBERS',
      direct_message_group_id: 'group-1',
      direct_message_allow_people_i_follow: false,
      direct_message_group_unavailable: false
    });
    expect(mockVisibleGroups).toHaveBeenCalledWith(
      ['group-1'],
      expect.objectContaining({
        authenticationContext: mockAuthenticationContext
      })
    );
    expect(mockUpsertPreferences).toHaveBeenCalledWith('profile-1', {
      direct_message_policy: 'GROUP_MEMBERS',
      direct_message_group_id: 'group-1',
      direct_message_allow_people_i_follow: false
    });
  });

  it('leaves the group requirement to the locked upsert, without a pre-read', async () => {
    await put({ direct_message_policy: 'GROUP_MEMBERS' });

    // The "GROUP_MEMBERS needs a group" invariant is checked inside
    // ProfilePreferencesDb.upsert under the profile-row lock.
    expect(mockGetPreferences).not.toHaveBeenCalled();
    expect(mockUpsertPreferences).toHaveBeenCalledWith('profile-1', {
      direct_message_policy: 'GROUP_MEMBERS'
    });
  });

  it('propagates the upsert rejection of the group policy without a group', async () => {
    mockUpsertPreferences.mockRejectedValue(
      new BadRequestException('Choose a group to limit who can message you.')
    );

    await expect(
      put({ direct_message_policy: 'GROUP_MEMBERS' })
    ).rejects.toThrow('Choose a group to limit who can message you.');
  });

  it.each([
    ['a group the profile cannot see', []],
    ['a direct-message group', [{ id: 'group-1', is_direct_message: true }]]
  ])('rejects %s', async (_name, groups) => {
    mockVisibleGroups.mockResolvedValue(groups);

    await expect(
      put({
        direct_message_policy: 'GROUP_MEMBERS',
        direct_message_group_id: 'group-1'
      })
    ).rejects.toThrow('Choose a group you can see');
    expect(mockUpsertPreferences).not.toHaveBeenCalled();
  });

  it('keeps the existing policies working without group checks', async () => {
    for (const policy of ['EVERYONE', 'PEOPLE_I_FOLLOW', 'NOBODY']) {
      await expect(
        put({ direct_message_policy: policy })
      ).resolves.toMatchObject({ direct_message_policy: policy });
    }
    expect(mockVisibleGroups).not.toHaveBeenCalled();
    expect(mockIsGroupUsable).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and policies', async () => {
    await expect(
      put({ direct_message_policy: 'FRIENDS' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(put({ direct_message_group: 'x' })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});
