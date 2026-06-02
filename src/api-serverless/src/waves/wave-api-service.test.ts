import { AuthenticationContext } from '@/auth-context';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWaveDecisionsStrategy } from '../generated/models/ApiWaveDecisionsStrategy';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '../generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '../generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import { ApiWaveParticipationSubmissionStrategyType } from '../generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { WaveApiService } from './wave.api.service';
import { mapWaveFieldsToApiSubmissionStrategy } from './wave-submission-strategy';
import {
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveSubmissionType,
  WaveType
} from '@/entities/IWave';
import { Time } from '@/time';

describe('WaveApiService updateWave immutability', () => {
  function createService({
    waveBeforeUpdate,
    updatedWave
  }: {
    waveBeforeUpdate: any;
    updatedWave?: any;
  }) {
    const connection = {} as any;
    const wavesApiDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findWaveById: jest
        .fn()
        .mockResolvedValueOnce(waveBeforeUpdate)
        .mockResolvedValue(updatedWave ?? waveBeforeUpdate),
      countWaveDecisionsByWaveIds: jest.fn().mockResolvedValue({}),
      deleteWave: jest.fn().mockResolvedValue(undefined),
      insertWave: jest.fn().mockResolvedValue(undefined),
      updateVisibilityInFeedEntities: jest.fn().mockResolvedValue(undefined),
      updateVisibilityInNotifications: jest.fn().mockResolvedValue(undefined)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]),
      getByIds: jest.fn().mockResolvedValue([])
    };
    const waveMappers = {
      createWaveToNewWaveEntity: jest.fn().mockResolvedValue(waveBeforeUpdate),
      waveEntityToApiWave: jest
        .fn()
        .mockResolvedValue({ id: waveBeforeUpdate.id })
    };
    const metricsRecorder = {
      recordActiveIdentity: jest.fn().mockResolvedValue(undefined)
    };
    const dropVotingService = {
      clearWaveLeaderboardEntriesOverThresholdSinceByWaveId: jest
        .fn()
        .mockResolvedValue(undefined)
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      waveMappers as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dropVotingService as any,
      {} as any,
      {} as any,
      {} as any,
      metricsRecorder as any,
      {} as any,
      {} as any,
      {} as any
    );
    jest
      .spyOn(service as any, 'validateWaveRelations')
      .mockResolvedValue(undefined);
    return {
      service,
      wavesApiDb,
      waveMappers,
      metricsRecorder,
      dropVotingService,
      connection,
      ctx: {
        authenticationContext: AuthenticationContext.fromProfileId(
          waveBeforeUpdate.created_by
        ),
        timer: undefined
      } as any
    };
  }

  function updateRequest({
    name = 'updated-wave',
    type = ApiWaveType.Rank,
    submissionStrategy,
    maxVotesPerIdentityToDrop,
    decisionsStrategy = null
  }: {
    name?: string;
    type?: ApiWaveType;
    submissionStrategy?: ApiUpdateWaveRequest['participation']['submission_strategy'];
    maxVotesPerIdentityToDrop?: number | null;
    decisionsStrategy?: ApiWaveDecisionsStrategy | null;
  }): ApiUpdateWaveRequest {
    return {
      name,
      picture: null,
      voting: {
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: submissionStrategy
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type,
        winning_threshold: null,
        max_winners: null,
        max_votes_per_identity_to_drop: maxVotesPerIdentityToDrop,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: decisionsStrategy,
        admin_drop_deletion_enabled: false
      }
    };
  }

  it('rejects changing wave type during update', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1'
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({ type: ApiWaveType.Chat }),
        ctx
      )
    ).rejects.toThrow(`Wave type cannot be changed after creation`);

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('rejects enabling identity submission strategy after creation', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        submission_type: null,
        identity_submission_strategy: null,
        identity_submission_duplicates: null
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          submissionStrategy: {
            type: ApiWaveParticipationSubmissionStrategyType.Identity,
            config: {
              duplicates:
                ApiWaveParticipationIdentitySubmissionAllowDuplicates.NeverAllow,
              who_can_be_submitted:
                ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.Everyone
            }
          }
        }),
        ctx
      )
    ).rejects.toThrow(
      `Wave identity submission strategy cannot be changed after creation`
    );

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('rejects changing identity submission details during update', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        submission_type: WaveSubmissionType.IDENTITY,
        identity_submission_strategy:
          WaveIdentitySubmissionStrategy.ONLY_OTHERS,
        identity_submission_duplicates:
          WaveIdentitySubmissionDuplicates.NEVER_ALLOW
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          submissionStrategy: {
            type: ApiWaveParticipationSubmissionStrategyType.Identity,
            config: {
              duplicates:
                ApiWaveParticipationIdentitySubmissionAllowDuplicates.AlwaysAllow,
              who_can_be_submitted:
                ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.OnlyOthers
            }
          }
        }),
        ctx
      )
    ).rejects.toThrow(
      `Wave identity submission strategy cannot be changed after creation`
    );

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('allows updates when immutable wave fields stay unchanged', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        submission_type: WaveSubmissionType.IDENTITY,
        identity_submission_strategy:
          WaveIdentitySubmissionStrategy.ONLY_OTHERS,
        identity_submission_duplicates:
          WaveIdentitySubmissionDuplicates.NEVER_ALLOW
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, waveMappers, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          name: 'renamed-wave',
          submissionStrategy:
            mapWaveFieldsToApiSubmissionStrategy(waveBeforeUpdate)!
        }),
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(wavesApiDb.deleteWave).toHaveBeenCalled();
    expect(waveMappers.createWaveToNewWaveEntity).toHaveBeenCalled();
  });

  it('allows renaming an ended wave with an existing past decision strategy', async () => {
    const existingDecisionStrategy = {
      first_decision_time: Time.currentMillis() - Time.hours(2).toMillis(),
      subsequent_decisions: [Time.hours(1).toMillis()],
      is_rolling: false
    };
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        decisions_strategy: existingDecisionStrategy,
        next_decision_time: null
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, waveMappers, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          name: 'renamed-ended-wave',
          decisionsStrategy: existingDecisionStrategy
        }),
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(wavesApiDb.deleteWave).toHaveBeenCalled();
    expect(waveMappers.createWaveToNewWaveEntity).toHaveBeenCalled();
  });

  it('preserves pending future decision time when the decision strategy is unchanged', async () => {
    const currentMillis = Time.currentMillis();
    const existingDecisionStrategy = {
      first_decision_time: currentMillis - Time.hours(5).toMillis(),
      subsequent_decisions: [Time.hours(10).toMillis()],
      is_rolling: false
    };
    const pendingDecisionTime = currentMillis + Time.hours(2).toMillis();
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        decisions_strategy: existingDecisionStrategy,
        next_decision_time: pendingDecisionTime
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, waveMappers, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          name: 'renamed-wave',
          decisionsStrategy: existingDecisionStrategy
        }),
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(waveMappers.createWaveToNewWaveEntity).toHaveBeenCalledWith(
      expect.objectContaining({ nextDecisionTime: pendingDecisionTime })
    );
  });

  it('rejects changing a decision strategy to start in the past', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        decisions_strategy: {
          first_decision_time: Time.currentMillis() + Time.hours(1).toMillis(),
          subsequent_decisions: [],
          is_rolling: false
        }
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({
          decisionsStrategy: {
            first_decision_time:
              Time.currentMillis() - Time.hours(2).toMillis(),
            subsequent_decisions: [],
            is_rolling: false
          }
        }),
        ctx
      )
    ).rejects.toThrow(`first_decision_time must be in the future`);

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('rejects lowering approve max_winners below existing decisions count', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.APPROVE,
        created_by: 'profile-1',
        max_winners: 5,
        winning_min_threshold: 10
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });
    (wavesApiDb.countWaveDecisionsByWaveIds as jest.Mock).mockResolvedValue({
      'wave-1': 4
    });

    await expect(
      service.updateWave(
        'wave-1',
        {
          ...updateRequest({ type: ApiWaveType.Approve }),
          wave: {
            ...updateRequest({ type: ApiWaveType.Approve }).wave,
            winning_threshold: 10,
            max_winners: 3
          }
        },
        ctx
      )
    ).rejects.toThrow(
      `max_winners can't be lower than already declared winners count`
    );

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('rejects lowering max_votes_per_identity_to_drop', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        max_votes_per_identity_to_drop: 5
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({ maxVotesPerIdentityToDrop: 4 }),
        ctx
      )
    ).rejects.toThrow(
      `max_votes_per_identity_to_drop can only be increased after creation`
    );

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('rejects changing max_votes_per_identity_to_drop from unlimited to finite', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        max_votes_per_identity_to_drop: null
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, ctx } = createService({ waveBeforeUpdate });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({ maxVotesPerIdentityToDrop: 3 }),
        ctx
      )
    ).rejects.toThrow(
      `max_votes_per_identity_to_drop can only be increased after creation`
    );

    expect(wavesApiDb.deleteWave).not.toHaveBeenCalled();
  });

  it('allows increasing max_votes_per_identity_to_drop', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        max_votes_per_identity_to_drop: 3
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, waveMappers, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({ maxVotesPerIdentityToDrop: 5 }),
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(wavesApiDb.deleteWave).toHaveBeenCalled();
    expect(waveMappers.createWaveToNewWaveEntity).toHaveBeenCalled();
  });

  it('allows removing max_votes_per_identity_to_drop by setting it to null', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.RANK,
        created_by: 'profile-1',
        max_votes_per_identity_to_drop: 3
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, wavesApiDb, waveMappers, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        updateRequest({ maxVotesPerIdentityToDrop: null }),
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(wavesApiDb.deleteWave).toHaveBeenCalled();
    expect(waveMappers.createWaveToNewWaveEntity).toHaveBeenCalled();
  });

  it('clears approve threshold state when threshold config changes', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.APPROVE,
        created_by: 'profile-1',
        winning_min_threshold: 10,
        winning_threshold_min_duration_ms: 0,
        time_lock_ms: null
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const { service, dropVotingService, connection, ctx } = createService({
      waveBeforeUpdate
    });

    await expect(
      service.updateWave(
        'wave-1',
        {
          ...updateRequest({ type: ApiWaveType.Approve }),
          wave: {
            ...updateRequest({ type: ApiWaveType.Approve }).wave,
            winning_threshold: 20,
            winning_threshold_min_duration_ms: Time.minutes(5).toMillis(),
            max_winners: null,
            time_lock_ms: Time.minutes(5).toMillis()
          }
        },
        ctx
      )
    ).resolves.toEqual({ id: 'wave-1' });

    expect(
      dropVotingService.clearWaveLeaderboardEntriesOverThresholdSinceByWaveId
    ).toHaveBeenCalledWith('wave-1', expect.objectContaining({ connection }));
  });
});

describe('WaveApiService validateWaveRelations', () => {
  function validationService(): WaveApiService {
    return new WaveApiService(
      {} as any,
      {
        getByIds: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null)
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
  }

  function baseCreateWaveRequest(): ApiCreateNewWave {
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
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: undefined as any,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Approve,
        winning_threshold: 100,
        winning_threshold_min_duration_ms: 0,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };
  }

  it('allows threshold duration combined with approve time lock', async () => {
    const service = validationService();
    const request = baseCreateWaveRequest();
    request.wave.winning_threshold_min_duration_ms =
      Time.minutes(10).toMillis();
    request.wave.time_lock_ms = Time.minutes(5).toMillis();

    await expect(
      (service as any).validateWaveRelations(request, {
        timer: undefined
      })
    ).resolves.toBeUndefined();
  });

  it('rejects zero threshold duration for non-approve waves', async () => {
    const service = validationService();
    const request = baseCreateWaveRequest();
    request.wave = {
      ...request.wave,
      type: ApiWaveType.Chat,
      winning_threshold: null,
      winning_threshold_min_duration_ms: 0
    };

    await expect(
      (service as any).validateWaveRelations(request, {
        timer: undefined
      })
    ).rejects.toThrow(
      'Only APPROVE waves support a winning_threshold_min_duration_ms'
    );
  });

  it('allows winning_threshold to be null for non-approve waves', async () => {
    const service = new WaveApiService(
      {} as any,
      {
        getByIds: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null)
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const request: ApiCreateNewWave = {
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
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: undefined as any,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Chat,
        winning_threshold: null,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };

    await expect(
      (service as any).validateWaveRelations(request, {
        timer: undefined
      })
    ).resolves.toBeUndefined();
  });

  it('rejects max_votes_per_identity_to_drop for chat waves', async () => {
    const service = new WaveApiService(
      {} as any,
      {
        getByIds: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null)
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const request: ApiCreateNewWave = {
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
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: undefined as any,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Chat,
        winning_threshold: null,
        max_winners: null,
        max_votes_per_identity_to_drop: 1,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };

    await expect(
      (service as any).validateWaveRelations(request, {
        timer: undefined
      })
    ).rejects.toThrow(
      `Only APPROVE and RANK waves support max_votes_per_identity_to_drop`
    );
  });

  it('allows missing winning_threshold for non-approve waves', async () => {
    const service = new WaveApiService(
      {} as any,
      {
        getByIds: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getProfileIdByIdentityKey: jest.fn().mockResolvedValue(null)
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const request = {
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
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: undefined,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: undefined,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: undefined,
        terms: null,
        submission_strategy: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Rank,
        time_lock_ms: null,
        max_votes_per_identity_to_drop: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };

    await expect(
      (service as any).validateWaveRelations(request, {
        timer: undefined
      })
    ).resolves.toBeUndefined();
  });
});

describe('WaveApiService subwave creation authorization', () => {
  function createService({
    parentWave,
    eligibleGroups
  }: {
    parentWave: any;
    eligibleGroups: string[];
  }) {
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue(parentWave)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(eligibleGroups)
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { service, wavesApiDb, userGroupsService };
  }

  const request = {
    parent_wave_id: 'parent-wave'
  } as ApiCreateNewWave;

  it('allows parent wave admins to create subwaves', async () => {
    const parentWave = aWave(
      {
        created_by: 'creator-profile',
        admin_group_id: 'admin-group'
      },
      {
        id: 'parent-wave',
        name: 'Parent Wave',
        serial_no: 1
      }
    );
    const { service } = createService({
      parentWave,
      eligibleGroups: ['admin-group']
    });

    await expect(
      (service as any).validateSubwaveCreationParent({
        request,
        actingAsId: 'admin-profile',
        ctx: { timer: undefined }
      })
    ).resolves.toBeUndefined();
  });

  it('rejects users who are neither parent creator nor parent admin', async () => {
    const parentWave = aWave(
      {
        created_by: 'creator-profile',
        admin_group_id: 'admin-group'
      },
      {
        id: 'parent-wave',
        name: 'Parent Wave',
        serial_no: 1
      }
    );
    const { service } = createService({
      parentWave,
      eligibleGroups: []
    });

    await expect(
      (service as any).validateSubwaveCreationParent({
        request,
        actingAsId: 'other-profile',
        ctx: { timer: undefined }
      })
    ).rejects.toThrow(
      `You can't create a subwave for a wave you didn't create and are not an admin of`
    );
  });

  it('rejects subwaves as parent waves', async () => {
    const parentWave = aWave(
      {
        created_by: 'creator-profile',
        parent_wave_id: 'grandparent-wave'
      },
      {
        id: 'parent-wave',
        name: 'Parent Wave',
        serial_no: 1
      }
    );
    const { service } = createService({
      parentWave,
      eligibleGroups: []
    });

    await expect(
      (service as any).validateSubwaveCreationParent({
        request,
        actingAsId: 'creator-profile',
        ctx: { timer: undefined }
      })
    ).rejects.toThrow(`Subwaves cannot be parent waves`);
  });
});

describe('WaveApiService wave pause authorization', () => {
  it('allows admin group members to create wave pauses when they are not the wave creator', async () => {
    const replicaCatchupDelay = process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE;
    process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE = '0';
    const nextDecisionTime = Time.currentMillis() + 60_000;
    const wave = aWave(
      {
        type: WaveType.RANK,
        created_by: 'creator-profile',
        admin_group_id: 'admin-group',
        decisions_strategy: {
          first_decision_time: nextDecisionTime,
          subsequent_decisions: [],
          is_rolling: false
        },
        next_decision_time: nextDecisionTime
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const connection = {} as any;
    const wavesApiDb = {
      findById: jest.fn().mockResolvedValue(wave),
      getWavePauses: jest.fn().mockResolvedValue([]),
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      insertPause: jest.fn().mockResolvedValue(undefined),
      deletePause: jest.fn().mockResolvedValue(undefined)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['admin-group'])
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    jest
      .spyOn(service, 'findWaveByIdOrThrow')
      .mockResolvedValue({ id: 'wave-1' } as any);

    try {
      await expect(
        service.createOrUpdateWavePause(
          'wave-1',
          {
            id: null,
            start_time: nextDecisionTime + 1_000,
            end_time: nextDecisionTime + 2_000
          },
          {
            authenticationContext:
              AuthenticationContext.fromProfileId('admin-profile')
          } as any
        )
      ).resolves.toEqual({ id: 'wave-1' });

      expect(wavesApiDb.insertPause).toHaveBeenCalledWith(
        {
          startTime: nextDecisionTime + 1_000,
          endTime: nextDecisionTime + 2_000,
          waveId: 'wave-1'
        },
        connection
      );
    } finally {
      if (replicaCatchupDelay === undefined) {
        delete process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE;
      } else {
        process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE = replicaCatchupDelay;
      }
    }
  });
});

describe('WaveApiService wave subscription group defaults', () => {
  function createService({
    existingActions = [],
    returnedActions = [ActivityEventAction.DROP_CREATED]
  }: {
    existingActions?: ActivityEventAction[];
    returnedActions?: ActivityEventAction[];
  }) {
    const connection = {} as any;
    const identitySubscriptionsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findIdentitySubscriptionActionsOfTarget: jest
        .fn()
        .mockResolvedValueOnce(existingActions)
        .mockResolvedValue(returnedActions),
      addIdentitySubscription: jest.fn().mockResolvedValue(undefined),
      deleteIdentitySubscription: jest.fn().mockResolvedValue(undefined)
    };
    const waveGroupNotificationSubscriptionsDb = {
      addDefaultGroupsForWaveSubscription: jest
        .fn()
        .mockResolvedValue(undefined),
      deleteForWave: jest.fn().mockResolvedValue(undefined)
    };
    const service = new WaveApiService(
      {} as any,
      {
        getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {} as any,
      identitySubscriptionsDb as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        recordActiveIdentity: jest.fn().mockResolvedValue(undefined)
      } as any,
      {} as any,
      {} as any,
      waveGroupNotificationSubscriptionsDb as any
    );
    jest
      .spyOn(service as any, 'findWaveByIdOrThrow')
      .mockResolvedValue({ id: 'wave-1' });

    return {
      service,
      connection,
      identitySubscriptionsDb,
      waveGroupNotificationSubscriptionsDb
    };
  }

  it('adds default group subscriptions when a user follows a wave', async () => {
    const {
      service,
      connection,
      identitySubscriptionsDb,
      waveGroupNotificationSubscriptionsDb
    } = createService({
      existingActions: [],
      returnedActions: [ActivityEventAction.DROP_CREATED]
    });

    await service.addWaveSubscriptionActions({
      subscriber: 'profile-1',
      waveId: 'wave-1',
      actions: [ApiWaveSubscriptionTargetAction.DropCreated]
    });

    expect(
      identitySubscriptionsDb.addIdentitySubscription
    ).toHaveBeenCalledWith(
      {
        subscriber_id: 'profile-1',
        target_id: 'wave-1',
        target_type: ActivityEventTargetType.WAVE,
        target_action: ActivityEventAction.DROP_CREATED,
        wave_id: 'wave-1',
        subscribed_to_all_drops: false
      },
      connection
    );
    expect(
      waveGroupNotificationSubscriptionsDb.addDefaultGroupsForWaveSubscription
    ).toHaveBeenCalledWith('profile-1', 'wave-1', connection);
  });

  it('does not re-add default group subscriptions when follow action already exists', async () => {
    const {
      service,
      identitySubscriptionsDb,
      waveGroupNotificationSubscriptionsDb
    } = createService({
      existingActions: [ActivityEventAction.DROP_CREATED],
      returnedActions: [ActivityEventAction.DROP_CREATED]
    });

    await service.addWaveSubscriptionActions({
      subscriber: 'profile-1',
      waveId: 'wave-1',
      actions: [ApiWaveSubscriptionTargetAction.DropCreated]
    });

    expect(
      identitySubscriptionsDb.addIdentitySubscription
    ).not.toHaveBeenCalled();
    expect(
      waveGroupNotificationSubscriptionsDb.addDefaultGroupsForWaveSubscription
    ).not.toHaveBeenCalled();
  });

  it('removes group subscriptions when a user unfollows a wave', async () => {
    const {
      service,
      connection,
      identitySubscriptionsDb,
      waveGroupNotificationSubscriptionsDb
    } = createService({
      existingActions: [],
      returnedActions: []
    });

    await service.removeWaveSubscriptionActions({
      subscriber: 'profile-1',
      waveId: 'wave-1',
      actions: [ApiWaveSubscriptionTargetAction.DropCreated]
    });

    expect(
      identitySubscriptionsDb.deleteIdentitySubscription
    ).toHaveBeenCalledWith(
      {
        subscriber_id: 'profile-1',
        target_id: 'wave-1',
        target_type: ActivityEventTargetType.WAVE,
        target_action: ActivityEventAction.DROP_CREATED
      },
      connection
    );
    expect(
      waveGroupNotificationSubscriptionsDb.deleteForWave
    ).toHaveBeenCalledWith('profile-1', 'wave-1', connection);
  });
});
