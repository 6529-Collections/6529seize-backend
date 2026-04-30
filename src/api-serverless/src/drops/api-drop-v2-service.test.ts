import { AuthenticationContext } from '@/auth-context';
import { DropEntity, DropType } from '@/entities/IDrop';
import { WaveCreditType, WaveEntity, WaveType } from '@/entities/IWave';
import { NotFoundException } from '@/exceptions';
import { ApiDropV2Service } from './api-drop-v2.service';

function makeDrop(overrides: Partial<DropEntity> = {}): DropEntity {
  return {
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
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false,
    ...overrides
  };
}

function makeWave(overrides: Partial<WaveEntity> = {}): WaveEntity {
  return {
    id: 'wave-1',
    serial_no: 1,
    name: 'Wave 1',
    picture: null,
    description_drop_id: 'description-drop-1',
    created_at: 100,
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
    participation_group_id: null,
    chat_enabled: true,
    chat_group_id: null,
    participation_max_applications_per_participant: null,
    participation_required_metadata: [],
    participation_required_media: [],
    submission_type: null,
    identity_submission_strategy: null,
    identity_submission_duplicates: null,
    participation_period_start: null,
    participation_period_end: null,
    participation_signature_required: false,
    participation_terms: null,
    type: WaveType.CHAT,
    winning_min_threshold: null,
    winning_max_threshold: null,
    max_winners: null,
    max_votes_per_identity_to_drop: null,
    time_lock_ms: null,
    decisions_strategy: null,
    next_decision_time: null,
    forbid_negative_votes: false,
    admin_drop_deletion_enabled: false,
    is_direct_message: false,
    ...overrides
  };
}

function createService() {
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest.fn().mockResolvedValue(makeDrop()),
    findWaveByIdOrNull: jest.fn().mockResolvedValue(makeWave())
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group-1'])
  };
  const apiDropMapper = {
    mapDrops: jest.fn().mockResolvedValue({
      'drop-1': { id: 'drop-1' }
    })
  };
  const apiWaveOverviewMapper = {
    mapWaves: jest.fn().mockResolvedValue({
      'wave-1': { id: 'wave-1' }
    })
  };

  return {
    service: new ApiDropV2Service(
      dropsDb as any,
      userGroupsService as any,
      apiDropMapper as any,
      apiWaveOverviewMapper as any
    ),
    deps: {
      dropsDb,
      userGroupsService,
      apiDropMapper,
      apiWaveOverviewMapper
    }
  };
}

describe('ApiDropV2Service', () => {
  it('finds visible drop and maps it with wave overview', async () => {
    const { service, deps } = createService();
    const drop = makeDrop();
    const wave = makeWave();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(drop);
    deps.dropsDb.findWaveByIdOrNull.mockResolvedValue(wave);

    const result = await service.findWithWaveByIdOrThrow('drop-1', {
      authenticationContext,
      connection
    });

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      wave: { id: 'wave-1' }
    });
    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith('viewer-1', undefined);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findWaveByIdOrNull).toHaveBeenCalledWith(
      'wave-1',
      connection
    );
    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalledWith([drop], {
      authenticationContext,
      connection
    });
    expect(deps.apiWaveOverviewMapper.mapWaves).toHaveBeenCalledWith([wave], {
      authenticationContext,
      connection
    });
  });

  it('throws when drop is missing or not visible', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findWithWaveByIdOrThrow('missing-drop', {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith(null, undefined);
    expect(deps.dropsDb.findWaveByIdOrNull).not.toHaveBeenCalled();
    expect(deps.apiDropMapper.mapDrops).not.toHaveBeenCalled();
    expect(deps.apiWaveOverviewMapper.mapWaves).not.toHaveBeenCalled();
  });

  it('throws when owning wave is missing', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findWaveByIdOrNull.mockResolvedValue(null);

    await expect(
      service.findWithWaveByIdOrThrow('drop-1', {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalled();
    expect(deps.apiWaveOverviewMapper.mapWaves).not.toHaveBeenCalled();
  });
});
