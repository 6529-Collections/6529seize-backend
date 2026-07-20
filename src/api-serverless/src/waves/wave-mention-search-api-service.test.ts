import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { IdentitiesDb } from '@/identities/identities.db';
import { WaveMentionSearchApiService } from './wave-mention-search.api.service';

describe('WaveMentionSearchApiService', () => {
  const searchWaveMentionCandidates = jest.fn();
  const findWavesByIds = jest.fn();
  const getGroupsUserIsEligibleFor = jest.fn();
  const getSqlAndParamsByGroupId = jest.fn();
  const identitiesDb = {
    searchWaveMentionCandidates
  } as unknown as IdentitiesDb;
  const wavesApiDb = { findWavesByIds } as unknown as WavesApiDb;
  const userGroupsService = {
    getGroupsUserIsEligibleFor,
    getSqlAndParamsByGroupId
  } as unknown as UserGroupsService;
  const service = new WaveMentionSearchApiService(
    identitiesDb,
    wavesApiDb,
    userGroupsService
  );

  beforeEach(() => {
    jest.clearAllMocks();
    searchWaveMentionCandidates.mockResolvedValue([]);
    getGroupsUserIsEligibleFor.mockResolvedValue(['visibility-group']);
  });

  it('restricts private-wave results and excludes the acting profile', async () => {
    const eligibility = {
      sql: 'with user_groups_view as (select profile_id from eligible)',
      params: { groupId: 'visibility-group' }
    };
    findWavesByIds.mockResolvedValue([
      { visibility_group_id: 'visibility-group' }
    ]);
    getSqlAndParamsByGroupId.mockResolvedValue(eligibility);
    const authenticationContext = {
      isUserFullyAuthenticated: () => true,
      isAuthenticatedAsProxy: () => false,
      getActingAsId: () => 'profile-me'
    };

    await service.search(
      { waveId: 'wave-1', handle: 'ali', limit: 5 },
      { authenticationContext: authenticationContext as any }
    );

    expect(getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'profile-me',
      undefined
    );
    expect(findWavesByIds).toHaveBeenCalledWith(
      ['wave-1'],
      ['visibility-group'],
      undefined
    );
    expect(getSqlAndParamsByGroupId).toHaveBeenCalledWith(
      'visibility-group',
      expect.objectContaining({ authenticationContext })
    );
    expect(searchWaveMentionCandidates).toHaveBeenCalledWith(
      {
        handle: 'ali',
        limit: 5,
        excludedProfileId: 'profile-me'
      },
      eligibility,
      expect.objectContaining({ authenticationContext })
    );
  });

  it('searches all profiles for a public wave without building a group view', async () => {
    findWavesByIds.mockResolvedValue([{ visibility_group_id: null }]);

    await service.search({ waveId: 'wave-1', handle: 'ali', limit: 5 }, {});

    expect(getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(findWavesByIds).toHaveBeenCalledWith(['wave-1'], [], undefined);
    expect(getSqlAndParamsByGroupId).not.toHaveBeenCalled();
    expect(searchWaveMentionCandidates).toHaveBeenCalledWith(
      { handle: 'ali', limit: 5, excludedProfileId: null },
      null,
      expect.any(Object)
    );
  });

  it('returns 404 without searching when an anonymous caller cannot read a private wave', async () => {
    findWavesByIds.mockResolvedValue([]);

    await expect(
      service.search({ waveId: 'private-wave', handle: 'ali', limit: 5 }, {})
    ).rejects.toThrow(NotFoundException);

    expect(getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(findWavesByIds).toHaveBeenCalledWith(
      ['private-wave'],
      [],
      undefined
    );
    expect(getSqlAndParamsByGroupId).not.toHaveBeenCalled();
    expect(searchWaveMentionCandidates).not.toHaveBeenCalled();
  });

  it('fails closed when private-wave eligibility cannot be resolved', async () => {
    findWavesByIds.mockResolvedValue([
      { visibility_group_id: 'visibility-group' }
    ]);
    getSqlAndParamsByGroupId.mockResolvedValue(null);

    await expect(
      service.search({ waveId: 'wave-1', handle: 'ali', limit: 5 }, {})
    ).resolves.toEqual([]);

    expect(searchWaveMentionCandidates).not.toHaveBeenCalled();
  });

  it('restricts private draft-wave results to the selected visibility group', async () => {
    const eligibility = {
      sql: 'with user_groups_view as (select profile_id from eligible)',
      params: { groupId: 'visibility-group' }
    };
    getSqlAndParamsByGroupId.mockResolvedValue(eligibility);
    const authenticationContext = {
      getActingAsId: () => 'profile-me'
    };

    await service.searchDraft(
      {
        visibilityGroupId: 'visibility-group',
        handle: 'ali',
        limit: 5
      },
      { authenticationContext: authenticationContext as any }
    );

    expect(findWavesByIds).not.toHaveBeenCalled();
    expect(getSqlAndParamsByGroupId).toHaveBeenCalledWith(
      'visibility-group',
      expect.objectContaining({ authenticationContext })
    );
    expect(searchWaveMentionCandidates).toHaveBeenCalledWith(
      {
        handle: 'ali',
        limit: 5,
        excludedProfileId: 'profile-me'
      },
      eligibility,
      expect.objectContaining({ authenticationContext })
    );
  });

  it('searches all profiles for a public draft wave', async () => {
    const authenticationContext = {
      getActingAsId: () => 'profile-me'
    };

    await service.searchDraft(
      { visibilityGroupId: null, handle: 'ali', limit: 5 },
      { authenticationContext: authenticationContext as any }
    );

    expect(getSqlAndParamsByGroupId).not.toHaveBeenCalled();
    expect(searchWaveMentionCandidates).toHaveBeenCalledWith(
      { handle: 'ali', limit: 5, excludedProfileId: 'profile-me' },
      null,
      expect.objectContaining({ authenticationContext })
    );
  });

  it('fails closed when draft visibility eligibility cannot be resolved', async () => {
    getSqlAndParamsByGroupId.mockResolvedValue(null);
    const authenticationContext = {
      getActingAsId: () => 'profile-me'
    };

    await expect(
      service.searchDraft(
        {
          visibilityGroupId: 'visibility-group',
          handle: 'ali',
          limit: 5
        },
        { authenticationContext: authenticationContext as any }
      )
    ).resolves.toEqual([]);

    expect(searchWaveMentionCandidates).not.toHaveBeenCalled();
  });

  it('requires an acting profile for draft-wave searches', async () => {
    const authenticationContext = {
      getActingAsId: () => null
    };

    await expect(
      service.searchDraft(
        { visibilityGroupId: null, handle: 'ali', limit: 5 },
        { authenticationContext: authenticationContext as any }
      )
    ).rejects.toThrow(ForbiddenException);

    expect(getSqlAndParamsByGroupId).not.toHaveBeenCalled();
    expect(searchWaveMentionCandidates).not.toHaveBeenCalled();
  });
});
