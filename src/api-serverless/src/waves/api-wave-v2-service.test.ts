import { AuthenticationContext } from '@/auth-context';
import { DropEntity, DropType } from '@/entities/IDrop';
import { WaveCreditType, WaveEntity, WaveType } from '@/entities/IWave';
import { NotFoundException } from '@/exceptions';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveV2Service } from '@/api/waves/api-wave-v2.service';

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
  const wave = makeWave();
  const dropsDb = {
    findWaveByIdOrNull: jest.fn().mockResolvedValue(wave),
    findLatestDropsSimple: jest.fn().mockResolvedValue([makeDrop()]),
    findDropByIdWithEligibilityCheck: jest
      .fn()
      .mockResolvedValue(makeDrop({ id: 'root-drop' })),
    getTraceForDrop: jest
      .fn()
      .mockResolvedValue([{ drop_id: 'root-drop', is_deleted: false }]),
    findLatestDropRepliesSimple: jest
      .fn()
      .mockResolvedValue([
        makeDrop({ id: 'reply-1', reply_to_drop_id: 'root-drop' })
      ])
  };
  const curationsDb = {
    findWaveCurationById: jest.fn().mockResolvedValue({
      id: 'curation-1',
      wave_id: 'wave-1'
    })
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group-1'])
  };
  const apiDropMapper = {
    mapDrops: jest.fn().mockImplementation(async (drops: DropEntity[]) =>
      drops.reduce(
        (acc, drop) => ({
          ...acc,
          [drop.id]: { id: drop.id }
        }),
        {}
      )
    )
  };
  const apiWaveOverviewMapper = {
    mapWaves: jest.fn().mockResolvedValue({
      'wave-1': { id: 'wave-1' }
    })
  };

  return {
    service: new ApiWaveV2Service(
      dropsDb as any,
      curationsDb as any,
      userGroupsService as any,
      apiDropMapper as any,
      apiWaveOverviewMapper as any
    ),
    deps: {
      dropsDb,
      curationsDb,
      userGroupsService,
      apiDropMapper,
      apiWaveOverviewMapper
    },
    wave
  };
}

describe('ApiWaveV2Service', () => {
  it('finds a visible wave feed and maps drops with V2 models', async () => {
    const { service, deps, wave } = createService();
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1'),
      connection: {} as any
    };

    const result = await service.findDropsFeed(
      {
        wave_id: 'wave-1',
        drop_id: null,
        amount: 10,
        serial_no_limit: 99,
        search_strategy: ApiDropSearchStrategy.Older,
        drop_type: ApiDropType.Chat,
        curation_id: 'curation-1'
      },
      ctx
    );

    expect(result).toEqual({
      drops: [{ id: 'drop-1' }],
      wave: { id: 'wave-1' }
    });
    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith('viewer-1', undefined);
    expect(deps.curationsDb.findWaveCurationById).toHaveBeenCalledWith(
      { id: 'curation-1' },
      ctx.connection
    );
    expect(deps.dropsDb.findLatestDropsSimple).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        amount: 10,
        serial_no_limit: 99,
        search_strategy: ApiDropSearchStrategy.Older,
        curation_id: 'curation-1',
        drop_type: DropType.CHAT
      },
      ctx
    );
    expect(deps.apiWaveOverviewMapper.mapWaves).toHaveBeenCalledWith(
      [wave],
      ctx
    );
    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalledWith([makeDrop()], ctx);
  });

  it('finds reply feeds with a V2 root drop and trace', async () => {
    const { service, deps } = createService();
    const rootDrop = makeDrop({ id: 'root-drop' });
    const reply = makeDrop({ id: 'reply-1', reply_to_drop_id: 'root-drop' });
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(rootDrop);
    deps.dropsDb.findLatestDropRepliesSimple.mockResolvedValue([reply]);

    const result = await service.findDropsFeed(
      {
        wave_id: 'wave-1',
        drop_id: 'root-drop',
        amount: 5,
        serial_no_limit: null,
        search_strategy: ApiDropSearchStrategy.Newer,
        drop_type: null,
        curation_id: null
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      }
    );

    expect(result).toEqual({
      drops: [{ id: 'reply-1' }],
      wave: { id: 'wave-1' },
      trace: [{ drop_id: 'root-drop', is_deleted: false }],
      root_drop: { id: 'root-drop' }
    });
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'root-drop',
      ['group-1'],
      undefined
    );
    expect(deps.dropsDb.findLatestDropRepliesSimple).toHaveBeenCalledWith(
      {
        drop_id: 'root-drop',
        amount: 5,
        serial_no_limit: null,
        search_strategy: ApiDropSearchStrategy.Newer,
        curation_id: null,
        drop_type: null
      },
      expect.any(Object)
    );
    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalledWith(
      [rootDrop, reply],
      expect.any(Object)
    );
  });

  it('hides curation feeds when the wave is not visible', async () => {
    const { service, deps } = createService();
    deps.userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    deps.dropsDb.findWaveByIdOrNull.mockResolvedValue(
      makeWave({ visibility_group_id: 'group-1' })
    );

    await expect(
      service.findDropsFeed(
        {
          wave_id: 'wave-1',
          drop_id: null,
          amount: 10,
          serial_no_limit: null,
          search_strategy: ApiDropSearchStrategy.Older,
          drop_type: null,
          curation_id: 'curation-1'
        },
        {
          authenticationContext: AuthenticationContext.notAuthenticated()
        }
      )
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findLatestDropsSimple).not.toHaveBeenCalled();
    expect(deps.apiDropMapper.mapDrops).not.toHaveBeenCalled();
  });
});
