import { AuthenticationContext } from '@/auth-context';
import { ActivityEventAction } from '@/entities/IActivityEvent';
import {
  WaveCreditScope,
  WaveCreditType,
  WaveEntity,
  WaveType
} from '@/entities/IWave';
import {
  ApiWaveOverviewMapper,
  createUnknownWaveCreatorProfile
} from './api-wave-overview.mapper';

function makeWave(overrides: Partial<WaveEntity> = {}): WaveEntity {
  return {
    id: 'wave-1',
    serial_no: 1,
    name: 'Wave 1',
    parent_wave_id: null,
    picture: null,
    description_drop_id: 'description-drop-1',
    created_at: 100,
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
    participation_group_id: null,
    chat_enabled: true,
    chat_group_id: null,
    chat_slow_mode_cooldown_ms: null,
    chat_links_disabled: false,
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
    winning_threshold_min_duration_ms: 0,
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

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'creator-1',
    handle: 'creator',
    pfp: 'creator.png',
    banner1_color: null,
    banner2_color: null,
    cic: 0,
    rep: 0,
    tdh: 0,
    tdh_rate: 0,
    xtdh: 0,
    xtdh_rate: 0,
    level: 42,
    classification: 'PSEUDONYM',
    sub_classification: null,
    primary_address: '0x0000000000000000000000000000000000000000',
    subscribed_actions: [],
    archived: false,
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    profile_wave_id: null,
    is_wave_creator: true,
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
    findFirstUnreadDropSerialNoByWaveId: jest.fn().mockResolvedValue({}),
    findWaveChatDropCooldownsByWaveIds: jest.fn().mockResolvedValue({}),
    findVisibleParentWavesByChildWaveIds: jest.fn().mockResolvedValue({}),
    findWaveIdsWithVisibleSubwaves: jest
      .fn()
      .mockResolvedValue(new Set<string>())
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
  const identityFetcher = {
    getOverviewsByIds: jest.fn().mockResolvedValue({
      'creator-1': makeProfile(),
      'parent-creator': makeProfile({
        id: 'parent-creator',
        handle: 'parentCreator'
      })
    })
  };

  return {
    mapper: new ApiWaveOverviewMapper(
      wavesApiDb as any,
      dropsDb as any,
      identitySubscriptionsDb as any,
      userGroupsService as any,
      directMessageWaveDisplayService as any,
      identityFetcher as any
    ),
    deps: {
      wavesApiDb,
      dropsDb,
      identitySubscriptionsDb,
      userGroupsService,
      directMessageWaveDisplayService,
      identityFetcher
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
      creator: makeProfile(),
      last_drop_time: 456,
      created_at: 100,
      subscribers_count: 11,
      has_competition: false,
      is_dm_wave: false,
      links_disabled: false,
      description_drop: {},
      total_drops_count: 3,
      is_private: false,
      ...expectedNeutralWaveRepAndScore()
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
    expect(deps.identityFetcher.getOverviewsByIds).toHaveBeenCalledWith(
      ['creator-1'],
      ctx
    );
  });

  it('maps disabled links flag from wave settings', async () => {
    const { mapper } = createMapper();

    const result = await mapper.mapWaves(
      [makeWave({ chat_links_disabled: true })],
      {
        authenticationContext: AuthenticationContext.notAuthenticated()
      }
    );

    expect(result['wave-1']?.links_disabled).toBe(true);
  });

  it('maps a level zero creator fallback when the profile is missing', async () => {
    const { mapper, deps } = createMapper();
    deps.identityFetcher.getOverviewsByIds.mockResolvedValue({});

    const result = await mapper.mapWaves([makeWave()], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(result['wave-1'].creator).toEqual(
      createUnknownWaveCreatorProfile({
        profileId: 'creator-1',
        waveId: 'wave-1'
      })
    );
  });

  it('does not fetch a malformed creator id when created_by is missing', async () => {
    const { mapper, deps } = createMapper();
    const waveWithoutCreator = makeWave({
      created_by: undefined as unknown as string
    });

    const result = await mapper.mapWaves([waveWithoutCreator], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(deps.identityFetcher.getOverviewsByIds).not.toHaveBeenCalled();
    expect(result['wave-1'].creator).toEqual(
      createUnknownWaveCreatorProfile({ waveId: 'wave-1' })
    );
  });

  it('maps visible parent wave and visible child presence', async () => {
    const { mapper, deps } = createMapper();
    const parentWave = makeWave({
      id: 'parent-wave',
      name: 'Parent Wave',
      created_by: 'parent-creator',
      description_drop_id: 'parent-description-drop'
    });
    const subwave = makeWave({
      id: 'subwave-1',
      name: 'Subwave',
      parent_wave_id: parentWave.id
    });
    deps.wavesApiDb.findVisibleParentWavesByChildWaveIds.mockResolvedValue({
      [subwave.id]: parentWave
    });
    deps.wavesApiDb.findWaveIdsWithVisibleSubwaves.mockResolvedValue(
      new Set([parentWave.id])
    );
    deps.wavesApiDb.findWavesMetricsByWaveIds.mockImplementation(
      async (waveIds: string[]) =>
        waveIds.reduce(
          (acc, waveId) => ({
            ...acc,
            [waveId]: makeMetric({ wave_id: waveId })
          }),
          {} as Record<string, ReturnType<typeof makeMetric>>
        )
    );

    const result = await mapper.mapWaves([subwave], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(result[subwave.id]).toEqual(
      expect.objectContaining({
        id: subwave.id,
        parent_wave: expect.objectContaining({
          id: parentWave.id,
          name: parentWave.name,
          creator: makeProfile({
            id: 'parent-creator',
            handle: 'parentCreator'
          }),
          has_subwaves: true
        })
      })
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
      creator: makeProfile(),
      pfp: 'display.png',
      last_drop_time: 456,
      created_at: 100,
      subscribers_count: 11,
      has_competition: true,
      is_dm_wave: true,
      links_disabled: false,
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
      },
      ...expectedNeutralWaveRepAndScore()
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

  it('maps active chat slow mode cooldown in context profile context', async () => {
    const { mapper, deps } = createMapper();
    const nextDropTimestamp = Date.now() + 60000;
    deps.wavesApiDb.findWaveChatDropCooldownsByWaveIds.mockResolvedValue({
      'wave-1': {
        wave_id: 'wave-1',
        profile_id: 'viewer-1',
        next_drop_timestamp: nextDropTimestamp,
        created_at: 1,
        updated_at: 1
      }
    });

    const result = await mapper.mapWaves(
      [
        makeWave({
          chat_slow_mode_cooldown_ms: 60000
        })
      ],
      {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      }
    );

    expect(result['wave-1']?.context_profile_context).toEqual({
      subscribed: false,
      pinned: false,
      can_chat: false,
      next_drop_allowed: nextDropTimestamp,
      unread_drops: 0,
      muted: false
    });
  });
});

function expectedNeutralWaveRepAndScore() {
  return {
    wave_rep: {
      total_rep: 0,
      positive_rep: 0,
      negative_rep: 0,
      contributor_count: 0,
      positive_contributor_count: 0,
      negative_contributor_count: 0,
      authenticated_user_contribution: null,
      categories: []
    },
    wave_score: {
      score_version: 'wave-score-v1',
      visibility_tier: 'EXPLORATION_NEUTRAL',
      quality_score: 0,
      hotness_score: 0,
      rep_sort_score: 50,
      visibility_score: 0,
      components: {
        creator_score: 0,
        level_weighted_participation_score: 0,
        trusted_diversity_score: 0,
        wave_rep_component_score: 50,
        trusted_subscription_score: 0,
        recent_trusted_activity_score: 0
      },
      penalties: {
        single_actor_penalty: 0,
        low_trust_flood_penalty: 0,
        cross_post_pressure: 0,
        cross_post_penalty: 0,
        negative_rep_penalty: 0,
        safety_multiplier: 1
      },
      quality_gate: {
        threshold: 25,
        multiplier: 0,
        gated_hotness_score: 0
      },
      formula: {
        max_level_raw_for_score: 25000000,
        max_wave_rep_for_score: 200000000,
        trusted_level_raw: 1000,
        low_trust_level_raw: 25,
        recent_activity_window_ms: 604800000,
        recent_activity_half_life_ms: 172800000,
        participation_saturation_scale: 600,
        trusted_diversity_saturation_scale: 8,
        trusted_subscription_saturation_scale: 30,
        recent_activity_saturation_scale: 250,
        trusted_visible_min_visibility_score: 55,
        exploration_neutral_min_visibility_score: 25,
        demoted_min_visibility_score: 10,
        quality_component_weights: {
          creator_score: 0.2,
          level_weighted_participation_score: 0.2,
          trusted_diversity_score: 0.15,
          trusted_subscription_score: 0.1,
          wave_rep_component_score: 0.35
        },
        hotness_component_weights: {
          recent_trusted_activity_score: 0.65,
          quality_score: 0.35
        },
        visibility_component_weights: {
          quality_score: 0.65,
          gated_hotness_score: 0.35
        }
      },
      calculated_at: 0
    }
  };
}
