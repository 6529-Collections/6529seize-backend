import { DropsMappers } from '@/api/drops/drops.mappers';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { DropEntity, DropType } from '@/entities/IDrop';
import { WaveCreditType, WaveType } from '@/entities/IWave';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { WaveQuickVoteApiService } from './wave-quick-vote.api.service';
import { WaveQuickVoteDb } from './wave-quick-vote.db';
import { WavesApiDb } from './waves.api.db';

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
