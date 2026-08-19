import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveGroupRole } from '@/api/generated/models/ApiWaveGroupRole';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { WaveApiService } from './wave.api.service';

const VIEW_GROUP_ID = 'view-group';
const DROP_GROUP_ID = 'drop-group';
const VOTE_GROUP_ID = 'vote-group';
const CHAT_GROUP_ID = 'chat-group';
const ADMIN_GROUP_ID = 'admin-group';

function createWaveRequest(): ApiCreateNewWave {
  return {
    name: 'wave',
    picture: null,
    description_drop: {
      title: null,
      signature: null,
      parts: [],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: []
    },
    voting: {
      scope: { group_id: VOTE_GROUP_ID },
      credit_type: ApiWaveCreditType.Tdh,
      credit_scope: undefined as never,
      credit_category: null,
      creditor_id: null,
      signature_required: false,
      forbid_negative_votes: false
    },
    visibility: { scope: { group_id: VIEW_GROUP_ID } },
    participation: {
      scope: { group_id: DROP_GROUP_ID },
      no_of_applications_allowed_per_participant: null,
      required_metadata: [],
      required_media: [],
      signature_required: false,
      terms: null,
      submission_strategy: null
    },
    chat: {
      scope: { group_id: CHAT_GROUP_ID },
      enabled: true
    },
    wave: {
      type: ApiWaveType.Rank,
      winning_threshold: null,
      max_winners: null,
      max_votes_per_identity_to_drop: null,
      time_lock_ms: null,
      admin_group: { group_id: ADMIN_GROUP_ID },
      decisions_strategy: null,
      admin_drop_deletion_enabled: false
    },
    outcomes: []
  };
}

function createService(outsideGroupIds: readonly string[] = []) {
  const wavesApiDb = {
    findWavesUsingGroupId: jest.fn().mockResolvedValue([])
  };
  const userGroupsService = {
    getApiGroupsByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id }))
    ),
    getApiGroupsVisibleToRequesterByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id }))
    ),
    findGroupIdsWithMembersOutsideContainingGroup: jest.fn(
      async (_viewGroup, containedGroups: Array<{ id: string }>) =>
        containedGroups
          .map((group) => group.id)
          .filter((groupId) => outsideGroupIds.includes(groupId))
    ),
    getGroupsUserIsEligibleForByIds: jest.fn().mockResolvedValue([])
  };
  const service = new WaveApiService(
    wavesApiDb as never,
    userGroupsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  return { service, userGroupsService, wavesApiDb };
}

describe('Wave group View containment', () => {
  it('fast-paths public View and identical groups', async () => {
    const { service, userGroupsService } = createService();

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: null,
          participation_group_id: null,
          admin_group_id: null
        },
        null,
        { timer: undefined }
      )
    ).resolves.toEqual([]);
    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          participation_group_id: VIEW_GROUP_ID
        },
        null,
        { timer: undefined }
      )
    ).resolves.toEqual([]);

    expect(
      userGroupsService.findGroupIdsWithMembersOutsideContainingGroup
    ).not.toHaveBeenCalled();
  });

  it('reports Everyone and explicit groups with members outside View', async () => {
    const { service } = createService([VOTE_GROUP_ID]);

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          participation_group_id: null,
          voting_group_id: VOTE_GROUP_ID,
          chat_group_id: VIEW_GROUP_ID
        },
        null,
        { timer: undefined }
      )
    ).resolves.toEqual([
      ApiWaveGroupRole.Participation,
      ApiWaveGroupRole.Voting
    ]);
  });

  it('does not treat a missing Admin group as an Everyone group', async () => {
    const { service } = createService();

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          admin_group_id: null
        },
        null,
        { timer: undefined }
      )
    ).resolves.toEqual([]);
  });

  it('does not disclose unavailable group ids from the preview boundary', async () => {
    const { service, userGroupsService } = createService();
    userGroupsService.getApiGroupsVisibleToRequesterByIds.mockResolvedValue([]);

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          voting_group_id: 'private-or-missing-group'
        },
        null,
        { timer: undefined }
      )
    ).rejects.toThrow(
      `One or more Wave groups were not found or aren't available`
    );
    expect(userGroupsService.getApiGroupsByIds).not.toHaveBeenCalled();
  });

  it('validates the authenticated default Admin against View', async () => {
    const { service } = createService();

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          include_authenticated_user_as_admin: true
        },
        'profile-1',
        { timer: undefined }
      )
    ).resolves.toEqual([ApiWaveGroupRole.Admin]);
  });

  it('checks the authenticated default Admin against the selected View group directly', async () => {
    const { service, userGroupsService } = createService();
    userGroupsService.getGroupsUserIsEligibleForByIds.mockResolvedValue([
      VIEW_GROUP_ID
    ]);

    await expect(
      service.validateWaveGroupContainmentPreview(
        {
          visibility_group_id: VIEW_GROUP_ID,
          include_authenticated_user_as_admin: true
        },
        'profile-1',
        { timer: undefined }
      )
    ).resolves.toEqual([]);

    expect(
      userGroupsService.getGroupsUserIsEligibleForByIds
    ).toHaveBeenCalledWith('profile-1', [VIEW_GROUP_ID], undefined);
  });

  it('rejects invalid privilege groups on create', async () => {
    const { service } = createService([VOTE_GROUP_ID]);

    await expect(
      (service as any).validateWaveRelations(createWaveRequest(), {
        timer: undefined
      })
    ).rejects.toThrow(
      'Wave VOTING group members must also belong to the View group'
    );
  });

  it('allows an unrelated update while validating a changed privilege group', async () => {
    const { service } = createService([VOTE_GROUP_ID]);
    const request = createWaveRequest();
    request.participation.scope.group_id = VIEW_GROUP_ID;
    const previousWave = {
      visibility_group_id: VIEW_GROUP_ID,
      participation_group_id: DROP_GROUP_ID,
      voting_group_id: VOTE_GROUP_ID,
      chat_group_id: CHAT_GROUP_ID,
      admin_group_id: ADMIN_GROUP_ID
    } as WaveEntity;

    await expect(
      (service as any).validateWaveRelations(
        request,
        { timer: undefined },
        previousWave
      )
    ).resolves.toBeUndefined();
  });

  it('blocks a published group replacement that would break containment', async () => {
    const { service, wavesApiDb } = createService(['candidate-group']);
    wavesApiDb.findWavesUsingGroupId.mockResolvedValue([
      {
        type: WaveType.RANK,
        chat_enabled: false,
        visibility_group_id: VIEW_GROUP_ID,
        participation_group_id: 'replaced-group',
        voting_group_id: VIEW_GROUP_ID,
        chat_group_id: null,
        admin_group_id: VIEW_GROUP_ID
      } as WaveEntity
    ]);

    const connection = {} as any;
    await expect(
      service.assertGroupReplacementPreservesWaveViewAccess(
        {
          currentGroup: { id: 'candidate-group' } as any,
          replacedGroupId: 'replaced-group'
        },
        { connection, timer: undefined }
      )
    ).rejects.toThrow(
      'Wave PARTICIPATION group members must also belong to the View group'
    );
    expect(wavesApiDb.findWavesUsingGroupId).toHaveBeenCalledWith(
      'replaced-group',
      expect.objectContaining({ connection })
    );
  });

  it('rechecks active roles and skips disabled Chat when View is replaced', async () => {
    const { service, userGroupsService, wavesApiDb } = createService([
      DROP_GROUP_ID
    ]);
    wavesApiDb.findWavesUsingGroupId.mockResolvedValue([
      {
        type: WaveType.RANK,
        chat_enabled: false,
        visibility_group_id: VIEW_GROUP_ID,
        participation_group_id: DROP_GROUP_ID,
        voting_group_id: VOTE_GROUP_ID,
        chat_group_id: CHAT_GROUP_ID,
        admin_group_id: ADMIN_GROUP_ID
      } as WaveEntity
    ]);

    await expect(
      service.assertGroupReplacementPreservesWaveViewAccess(
        {
          currentGroup: { id: 'candidate-view' } as any,
          replacedGroupId: VIEW_GROUP_ID
        },
        { connection: {} as any, timer: undefined }
      )
    ).rejects.toThrow(
      'Wave PARTICIPATION group members must also belong to the View group'
    );
    expect(
      userGroupsService.findGroupIdsWithMembersOutsideContainingGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'candidate-view' }),
      expect.not.arrayContaining([
        expect.objectContaining({ id: CHAT_GROUP_ID })
      ]),
      expect.anything()
    );
  });
});
