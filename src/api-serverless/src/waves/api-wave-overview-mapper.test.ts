import { AuthenticationContext } from '@/auth-context';
import { ActivityEventAction } from '@/entities/IActivityEvent';
import { WaveCreditType, WaveEntity, WaveType } from '@/entities/IWave';
import { ApiWaveOverviewMapper } from './api-wave-overview.mapper';

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

function makeMetric(overrides: Record<string, unknown> = {}) {
  return {
    wave_id: 'wave-1',
    drops_count: 3,
    participatory_drops_count: 1,
    subscribers_count: 11,
    latest_drop_timestamp: 456,
    ...overrides
  };
}

function createMapper() {
  const wavesApiDb = {
    findWavesMetricsByWaveIds: jest.fn().mockResolvedValue({
      'wave-1': makeMetric()
    }),
    whichOfWavesArePinnedByGivenProfile: jest
      .fn()
      .mockResolvedValue(new Set<string>()),
    findWaveReaderMetricsByWaveIds: jest.fn().mockResolvedValue({}),
    findIdentityUnreadDropsCountByWaveId: jest.fn().mockResolvedValue({}),
    findFirstUnreadDropSerialNoByWaveId: jest.fn().mockResolvedValue({})
  };
  const dropsDb = {
    getDropPartOnes: jest.fn().mockResolvedValue({}),
    getDropPartOneMedia: jest.fn().mockResolvedValue({})
  };
  const identitySubscriptionsDb = {
    findIdentitySubscriptionActionsOfTargets: jest.fn().mockResolvedValue({})
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const directMessageWaveDisplayService = {
    resolveWaveDisplayByWaveIdForContext: jest.fn().mockResolvedValue({})
  };

  return {
    mapper: new ApiWaveOverviewMapper(
      wavesApiDb as any,
      dropsDb as any,
      identitySubscriptionsDb as any,
      userGroupsService as any,
      directMessageWaveDisplayService as any
    ),
    deps: {
      wavesApiDb,
      dropsDb,
      identitySubscriptionsDb,
      userGroupsService,
      directMessageWaveDisplayService
    }
  };
}

describe('ApiWaveOverviewMapper', () => {
  it('maps minimal overview and omits missing optional fields', async () => {
    const { mapper, deps } = createMapper();
    const ctx = {
      authenticationContext: AuthenticationContext.notAuthenticated()
    };

    const result = await mapper.mapWaves([makeWave()], ctx);

    expect(result['wave-1']).toEqual({
      id: 'wave-1',
      name: 'Wave 1',
      last_drop_time: 456,
      created_at: 100,
      subscribers_count: 11,
      has_competition: false,
      is_dm_wave: false,
      description_drop: {},
      total_drops_count: 3,
      is_private: false
    });
    expect(result['wave-1']).not.toHaveProperty('pfp');
    expect(result['wave-1']).not.toHaveProperty('context_profile_context');
    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).not.toHaveBeenCalled();
    expect(
      deps.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets
    ).not.toHaveBeenCalled();
    expect(
      deps.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext
    ).not.toHaveBeenCalled();
    expect(deps.dropsDb.getDropPartOnes).toHaveBeenCalledWith(
      ['description-drop-1'],
      ctx
    );
    expect(deps.dropsDb.getDropPartOneMedia).toHaveBeenCalledWith(
      ['description-drop-1'],
      ctx
    );
  });

  it('maps part-one description drop content, media, total drops count and privacy', async () => {
    const { mapper, deps } = createMapper();
    deps.dropsDb.getDropPartOnes.mockResolvedValue({
      'description-drop-1': {
        drop_id: 'description-drop-1',
        drop_part_id: 1,
        content: 'Wave description',
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: 'wave-1'
      }
    });
    deps.dropsDb.getDropPartOneMedia.mockResolvedValue({
      'description-drop-1': [
        {
          id: '1',
          drop_id: 'description-drop-1',
          drop_part_id: 1,
          url: 'https://example.com/image.png',
          mime_type: 'image/png',
          wave_id: 'wave-1'
        }
      ]
    });

    const result = await mapper.mapWaves(
      [makeWave({ visibility_group_id: 'viewer-group' })],
      {
        authenticationContext: AuthenticationContext.notAuthenticated()
      }
    );

    expect(result['wave-1']).toEqual(
      expect.objectContaining({
        description_drop: {
          contents: 'Wave description',
          media: [
            {
              url: 'https://example.com/image.png',
              mime_type: 'image/png'
            }
          ]
        },
        total_drops_count: 3,
        is_private: true
      })
    );
  });

  it('maps authenticated context and direct-message display overrides', async () => {
    const { mapper, deps } = createMapper();
    const wave = makeWave({
      type: WaveType.RANK,
      picture: 'original.png',
      chat_group_id: 'chat-group',
      is_direct_message: true
    });
    deps.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext.mockResolvedValue(
      {
        'wave-1': {
          name: 'Direct Chat',
          picture: 'display.png',
          contributors: [
            {
              handle: 'alice',
              pfp: 'alice.png'
            },
            {
              handle: 'bob',
              pfp: null
            }
          ]
        }
      }
    );
    deps.userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([
      'chat-group'
    ]);
    deps.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets.mockResolvedValue(
      {
        'wave-1': [ActivityEventAction.DROP_CREATED]
      }
    );
    deps.wavesApiDb.whichOfWavesArePinnedByGivenProfile.mockResolvedValue(
      new Set(['wave-1'])
    );
    deps.wavesApiDb.findWaveReaderMetricsByWaveIds.mockResolvedValue({
      'wave-1': {
        wave_id: 'wave-1',
        reader_id: 'viewer-1',
        latest_read_timestamp: 200,
        muted: true
      }
    });
    deps.wavesApiDb.findIdentityUnreadDropsCountByWaveId.mockResolvedValue({
      'wave-1': 7
    });
    deps.wavesApiDb.findFirstUnreadDropSerialNoByWaveId.mockResolvedValue({
      'wave-1': 19
    });

    const result = await mapper.mapWaves([wave], {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    });

    expect(result['wave-1']).toEqual({
      id: 'wave-1',
      name: 'Direct Chat',
      pfp: 'display.png',
      last_drop_time: 456,
      created_at: 100,
      subscribers_count: 11,
      has_competition: true,
      is_dm_wave: true,
      description_drop: {},
      total_drops_count: 3,
      is_private: false,
      contributors: [
        {
          handle: 'alice',
          pfp: 'alice.png'
        },
        {
          handle: 'bob',
          pfp: null
        }
      ],
      context_profile_context: {
        subscribed: true,
        pinned: true,
        can_chat: true,
        unread_drops: 7,
        first_unread_drop_serial_no: 19,
        muted: true
      }
    });
    expect(
      deps.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext
    ).toHaveBeenCalledWith(
      {
        waveEntities: [wave],
        contextProfileId: 'viewer-1'
      },
      undefined
    );
  });
});
