import { DropsMappers } from '@/api/drops/drops.mappers';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { DropEntity, DropType } from '@/entities/IDrop';
import { WaveCreditScope, WaveCreditType, WaveType } from '@/entities/IWave';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { WaveQuickVoteApiService } from './wave-quick-vote.api.service';
import { WaveQuickVoteDb } from './wave-quick-vote.db';
import { WavesApiDb } from './waves.api.db';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { competitionAnonymityViewerId } from '@/competitions/competition-anonymity';
import { ApiDrop } from '@/api/generated/models/ApiDrop';

describe('WaveQuickVoteApiService', () => {
  let service: WaveQuickVoteApiService;
  let waveQuickVoteDb: WaveQuickVoteDb;
  let wavesApiDb: WavesApiDb;
  let userGroupsService: UserGroupsService;
  let dropsMappers: DropsMappers;

  const drop: DropEntity = {
    serial_no: 1,
    id: 'drop-1',
    wave_id: 'wave-1',
    author_id: 'author-1',
    created_at: 100,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.PARTICIPATORY,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false
  };

  const wave = {
    id: 'wave-1',
    name: 'Wave 1',
    picture: null,
    description_drop_id: 'description-drop-1',
    last_drop_time: 0,
    created_at: 0,
    updated_at: null,
    created_by: 'creator-1',
    voting_group_id: null,
    admin_group_id: null,
    voting_credit_type: WaveCreditType.TDH,
    voting_credit_scope: WaveCreditScope.WAVE,
    voting_credit_category: null,
    voting_credit_creditor: null,
    voting_signature_required: false,
    voting_period_start: null,
    voting_period_end: null,
    visibility_group_id: null,
    chat_group_id: null,
    chat_enabled: true,
    participation_group_id: null,
    participation_max_applications_per_participant: null,
    participation_required_metadata: [],
    participation_required_media: [],
    participation_period_start: null,
    participation_period_end: null,
    participation_signature_required: false,
    participation_terms: null,
    type: WaveType.RANK,
    winning_min_threshold: null,
    winning_max_threshold: null,
    winning_threshold_min_duration_ms: 0,
    max_winners: null,
    time_lock_ms: null,
    decisions_strategy: null,
    next_decision_time: null,
    forbid_negative_votes: false,
    admin_drop_deletion_enabled: false,
    is_direct_message: false,
    serial_no: 1
  };

  beforeEach(() => {
    waveQuickVoteDb = mock();
    wavesApiDb = mock();
    userGroupsService = mock();
    dropsMappers = mock();
    when(wavesApiDb.countWaveDecisionsByWaveIds)
      .calledWith(['wave-1'], {})
      .mockResolvedValue({});
    service = new WaveQuickVoteApiService(
      waveQuickVoteDb,
      wavesApiDb,
      userGroupsService,
      dropsMappers
    );
  });

  it('rejects quick vote reads when a public child has a restricted parent', async () => {
    jest
      .mocked(wavesApiDb.findWaveById)
      .mockResolvedValueOnce({ ...wave, parent_wave_id: 'parent' } as never)
      .mockResolvedValueOnce({
        ...wave,
        id: 'parent',
        visibility_group_id: 'parent-group'
      } as never);
    jest
      .mocked(userGroupsService.getGroupsUserIsEligibleFor)
      .mockResolvedValue([]);
    await expect(
      service.findUndiscoveredDrop(
        { waveId: 'wave-1', identityId: 'viewer' },
        {}
      )
    ).rejects.toThrow('Wave wave-1 not found');
    expect(waveQuickVoteDb.countUnvotedDrops).not.toHaveBeenCalled();
  });

  it('returns the mapped drop when one undiscovered drop is available', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue(wave as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);
    when(waveQuickVoteDb.findNextUndiscoveredDrop)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(drop);
    when(waveQuickVoteDb.countUnvotedDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(waveQuickVoteDb.countUndiscoveredDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(dropsMappers.convertToDropFulls)
      .calledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1'
        },
        undefined
      )
      .mockResolvedValue([{ id: drop.id } as any]);

    const result = await service.findUndiscoveredDrop(
      {
        waveId: 'wave-1',
        identityId: 'identity-1'
      },
      {}
    );

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      left_to_vote_in_current_round: 2,
      total_count: 2
    });
  });

  it.each([
    { viewer: 'owner', action: null, privateOwnerId: 'identity-1' },
    {
      viewer: 'voting proxy',
      action: ProfileProxyActionType.RATE_WAVE_DROP,
      privateOwnerId: null
    },
    {
      viewer: 'reading proxy',
      action: ProfileProxyActionType.READ_WAVE,
      privateOwnerId: 'identity-1'
    }
  ])(
    'preserves the original $viewer context while hydrating a quick vote card',
    async ({ action, privateOwnerId }) => {
      const authenticationContext = action
        ? new AuthenticationContext({
            authenticatedWallet: null,
            authenticatedProfileId: 'delegate',
            roleProfileId: 'identity-1',
            activeProxyActions: [
              {
                id: 'action',
                type: action,
                credit_amount: null,
                credit_spent: null
              }
            ]
          })
        : AuthenticationContext.fromProfileId('identity-1');
      const connection = { connection: {} };
      const ctx = { authenticationContext, connection };
      jest.mocked(wavesApiDb.findWaveById).mockResolvedValue(wave as never);
      jest.mocked(wavesApiDb.countWaveDecisionsByWaveIds).mockResolvedValue({});
      jest
        .mocked(userGroupsService.getGroupsUserIsEligibleFor)
        .mockResolvedValue([]);
      jest.mocked(waveQuickVoteDb.countUnvotedDrops).mockResolvedValue(2);
      jest.mocked(waveQuickVoteDb.countUndiscoveredDrops).mockResolvedValue(2);
      jest
        .mocked(waveQuickVoteDb.findNextUndiscoveredDrop)
        .mockResolvedValue(drop);
      jest
        .mocked(dropsMappers.convertToDropFulls)
        .mockResolvedValue([{ id: drop.id } as ApiDrop]);

      const result = await service.findUndiscoveredDrop(
        { waveId: wave.id, identityId: 'identity-1' },
        ctx
      );

      expect(result.drop?.id).toBe(drop.id);
      expect(dropsMappers.convertToDropFulls).toHaveBeenCalledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1',
          authenticationContext
        },
        connection
      );
      const forwarded = jest.mocked(dropsMappers.convertToDropFulls).mock
        .calls[0][0].authenticationContext;
      expect(forwarded).toBe(authenticationContext);
      expect(
        competitionAnonymityViewerId({ authenticationContext: forwarded })
      ).toBe(privateOwnerId);
      expect(forwarded?.hasRightsTo(ProfileProxyActionType.READ_WAVE)).toBe(
        privateOwnerId !== null
      );
    }
  );

  it('falls back to the earliest skipped unvoted drop when everything is already skipped', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue(wave as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);
    when(waveQuickVoteDb.findNextUndiscoveredDrop)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(null);
    when(waveQuickVoteDb.countUnvotedDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(waveQuickVoteDb.countUndiscoveredDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(0);
    when(waveQuickVoteDb.findSkippedUnvotedDropBySkip)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 0
        },
        {}
      )
      .mockResolvedValue(drop);
    when(dropsMappers.convertToDropFulls)
      .calledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1'
        },
        undefined
      )
      .mockResolvedValue([{ id: drop.id } as any]);

    const result = await service.findUndiscoveredDrop(
      {
        waveId: 'wave-1',
        identityId: 'identity-1'
      },
      {}
    );

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      left_to_vote_in_current_round: 0,
      total_count: 2
    });
  });

  it('uses the skip offset when provided', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue(wave as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);
    when(waveQuickVoteDb.findUndiscoveredDropBySkip)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 1
        },
        {}
      )
      .mockResolvedValue(drop);
    when(waveQuickVoteDb.countUnvotedDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(waveQuickVoteDb.countUndiscoveredDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(dropsMappers.convertToDropFulls)
      .calledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1'
        },
        undefined
      )
      .mockResolvedValue([{ id: drop.id } as any]);

    const result = await service.findUndiscoveredDrop(
      {
        waveId: 'wave-1',
        identityId: 'identity-1',
        skip: 1
      },
      {}
    );

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      left_to_vote_in_current_round: 2,
      total_count: 2
    });
  });

  it('continues into skipped drops when the offset goes past the remaining undiscovered drops', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue(wave as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);
    when(waveQuickVoteDb.countUnvotedDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(4);
    when(waveQuickVoteDb.countUndiscoveredDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(1);
    when(waveQuickVoteDb.findSkippedUnvotedDropBySkip)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 1
        },
        {}
      )
      .mockResolvedValue(drop);
    when(dropsMappers.convertToDropFulls)
      .calledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1'
        },
        undefined
      )
      .mockResolvedValue([{ id: drop.id } as any]);

    const result = await service.findUndiscoveredDrop(
      {
        waveId: 'wave-1',
        identityId: 'identity-1',
        skip: 2
      },
      {}
    );

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      left_to_vote_in_current_round: 1,
      total_count: 4
    });
  });

  it('falls back to skipped drops when everything is already skipped', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue(wave as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);
    when(waveQuickVoteDb.countUndiscoveredDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(0);
    when(waveQuickVoteDb.findSkippedUnvotedDropBySkip)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1',
          skip: 1
        },
        {}
      )
      .mockResolvedValue(drop);
    when(waveQuickVoteDb.countUnvotedDrops)
      .calledWith(
        {
          identity_id: 'identity-1',
          wave_id: 'wave-1'
        },
        {}
      )
      .mockResolvedValue(2);
    when(dropsMappers.convertToDropFulls)
      .calledWith(
        {
          dropEntities: [drop],
          contextProfileId: 'identity-1'
        },
        undefined
      )
      .mockResolvedValue([{ id: drop.id } as any]);

    const result = await service.findUndiscoveredDrop(
      {
        waveId: 'wave-1',
        identityId: 'identity-1',
        skip: 1
      },
      {}
    );

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      left_to_vote_in_current_round: 0,
      total_count: 2
    });
  });

  it('rejects when the identity is not eligible to vote in the wave', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue({
        ...wave,
        voting_group_id: 'group-1'
      } as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);

    await expect(
      service.findUndiscoveredDrop(
        {
          waveId: 'wave-1',
          identityId: 'identity-1'
        },
        {}
      )
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the wave is a chat wave', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue({
        ...wave,
        type: WaveType.CHAT
      } as any);
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);

    await expect(
      service.findUndiscoveredDrop(
        {
          waveId: 'wave-1',
          identityId: 'identity-1'
        },
        {}
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when the approve wave is already closed', async () => {
    when(wavesApiDb.findWaveById)
      .calledWith('wave-1', undefined)
      .mockResolvedValue({
        ...wave,
        type: WaveType.APPROVE,
        max_winners: 1
      } as any);
    when(wavesApiDb.countWaveDecisionsByWaveIds)
      .calledWith(['wave-1'], {})
      .mockResolvedValue({ 'wave-1': 1 });
    when(userGroupsService.getGroupsUserIsEligibleFor)
      .calledWith('identity-1', undefined)
      .mockResolvedValue([]);

    await expect(
      service.findUndiscoveredDrop(
        {
          waveId: 'wave-1',
          identityId: 'identity-1'
        },
        {}
      )
    ).rejects.toThrow(`Voting is closed in this wave`);
  });
});
