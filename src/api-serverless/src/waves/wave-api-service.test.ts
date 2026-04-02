import { AuthenticationContext } from '@/auth-context';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '../generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '../generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import { ApiWaveParticipationSubmissionStrategyType } from '../generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { WaveApiService } from './wave.api.service';
import { mapWaveFieldsToApiSubmissionStrategy } from './wave-submission-strategy';
import {
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveSubmissionType,
  WaveType
} from '@/entities/IWave';

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
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      waveMappers as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
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
    submissionStrategy
  }: {
    name?: string;
    type?: ApiWaveType;
    submissionStrategy?: ApiUpdateWaveRequest['participation']['submission_strategy'];
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
        winning_thresholds: null,
        max_winners: 3,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: null,
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
});
