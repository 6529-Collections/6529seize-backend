import { AuthenticationContext } from '@/auth-context';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { WaveApiService } from './wave.api.service';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { WaveType } from '@/entities/IWave';

function updateRequest(visibilityGroupId: string | null): ApiUpdateWaveRequest {
  return {
    name: 'updated-wave',
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
      scope: { group_id: visibilityGroupId }
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
    }
  };
}

describe('WaveApiService profile wave safeguards', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects making a selected profile wave private', async () => {
    const waveBeforeUpdate = aWave(
      {
        type: WaveType.CHAT,
        created_by: 'profile-1'
      },
      {
        id: 'wave-1',
        name: 'wave-1',
        serial_no: 1
      }
    );
    const connection = {} as any;
    const wavesApiDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (fn) => await fn(connection)
      ),
      findWaveById: jest.fn().mockResolvedValue(waveBeforeUpdate)
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) } as any,
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
      .spyOn(profileWavesDb, 'findSelectedWaveIdsByWaveIds')
      .mockResolvedValue(new Set(['wave-1']));

    await expect(
      service.updateWave('wave-1', updateRequest('group-1'), {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      } as any)
    ).rejects.toThrow(`Profile waves must remain public`);
  });

  it('clears profile wave selection when deleting a wave', async () => {
    const connection = {} as any;
    const dropsDb = {
      deleteDropGroupMentionsByWaveId: jest.fn().mockResolvedValue(undefined)
    };
    const waveGroupNotificationSubscriptionsDb = {
      deleteByWaveId: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (fn) => await fn(connection)
      ),
      findWaveById: jest.fn().mockResolvedValue(
        aWave(
          {
            created_by: 'profile-1'
          },
          {
            id: 'wave-1',
            name: 'wave-1',
            serial_no: 1
          }
        )
      ),
      deleteDropPartsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropMentionsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropMentionedWavesByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropMediaByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropReferencedNftsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropMetadataByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropFeedItemsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropNotificationsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropSubscriptionsByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteDropEntitiesByWaveId: jest.fn().mockResolvedValue(undefined),
      deleteWaveMetrics: jest.fn().mockResolvedValue(undefined),
      deleteWave: jest.fn().mockResolvedValue(undefined),
      deleteWaveOutcomes: jest.fn().mockResolvedValue(undefined),
      deleteWaveOutcomeDistributionItems: jest
        .fn()
        .mockResolvedValue(undefined),
      deleteDropRelations: jest.fn().mockResolvedValue(undefined),
      deleteBoosts: jest.fn().mockResolvedValue(undefined)
    };
    const deleteByWaveIdSpy = jest
      .spyOn(profileWavesDb, 'deleteByWaveId')
      .mockResolvedValue(undefined);
    const service = new WaveApiService(
      wavesApiDb as any,
      { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { deleteVoteByWave: jest.fn().mockResolvedValue(undefined) } as any,
      { deleteReactionsByWave: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
      { recordActiveIdentity: jest.fn().mockResolvedValue(undefined) } as any,
      {
        deleteDropCurationsByWaveId: jest.fn().mockResolvedValue(undefined),
        deleteWaveCurationsByWaveId: jest.fn().mockResolvedValue(undefined)
      } as any,
      dropsDb as any,
      waveGroupNotificationSubscriptionsDb as any
    );

    await expect(
      service.deleteWave('wave-1', {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      } as any)
    ).resolves.toBeUndefined();

    expect(deleteByWaveIdSpy).toHaveBeenCalledWith(
      'wave-1',
      expect.objectContaining({ connection })
    );
    expect(dropsDb.deleteDropGroupMentionsByWaveId).toHaveBeenCalledWith(
      'wave-1',
      expect.objectContaining({ connection })
    );
    expect(
      waveGroupNotificationSubscriptionsDb.deleteByWaveId
    ).toHaveBeenCalledWith('wave-1', connection);
  });
});
