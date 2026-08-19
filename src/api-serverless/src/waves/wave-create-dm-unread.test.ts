import { AuthenticationContext } from '@/auth-context';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { DbPoolName } from '@/db-query.options';
import { WaveApiService } from './wave.api.service';

jest.mock('@/api/waves/wave-score.service', () => ({
  waveScoreService: {
    requestWaveScoreRefreshBestEffort: jest.fn()
  },
  WaveScoreDirtyRefreshReason: { DROP_CHANGED: 'DROP_CHANGED' }
}));

const mockRequestWaveScoreRefreshBestEffort = jest.mocked(
  waveScoreService.requestWaveScoreRefreshBestEffort
);

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForReaderWave: jest.fn(),
  invalidateWaveUnreadCacheForWave: jest.fn()
}));

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn()
}));

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn()
}));

const mockInvalidateWaveUnreadCacheForWave = jest.mocked(
  invalidateWaveUnreadCacheForWave
);
const mockGiveReadReplicaTimeToCatchUp = jest.mocked(
  giveReadReplicaTimeToCatchUp
);
const mockSendIdentityPushNotifications = jest.mocked(
  sendIdentityPushNotifications
);

function createWaveRequest(): ApiCreateNewWave {
  return {
    name: 'DM',
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
    visibility: { scope: { group_id: 'dm-group' } },
    participation: {
      scope: { group_id: 'dm-group' },
      no_of_applications_allowed_per_participant: null,
      required_metadata: [],
      required_media: [],
      signature_required: false,
      period: undefined,
      terms: null,
      submission_strategy: null
    },
    chat: { scope: { group_id: 'dm-group' }, enabled: true },
    wave: {
      type: ApiWaveType.Chat,
      winning_threshold: null,
      max_winners: null,
      max_votes_per_identity_to_drop: null,
      time_lock_ms: null,
      admin_group: { group_id: 'dm-group' },
      decisions_strategy: null,
      admin_drop_deletion_enabled: false
    },
    outcomes: []
  };
}

describe('WaveApiService direct-message creation unread synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestWaveScoreRefreshBestEffort.mockResolvedValue(undefined);
    mockInvalidateWaveUnreadCacheForWave.mockResolvedValue(undefined);
    mockGiveReadReplicaTimeToCatchUp.mockResolvedValue(undefined);
    mockSendIdentityPushNotifications.mockResolvedValue(undefined);
  });

  it('broadcasts the initial description drop unread state after commit', async () => {
    const connection = {} as any;
    let transactionCommitted = false;
    const dmUnreadState = {
      profile_id: 'recipient-1',
      wave_id: 'wave-1',
      unread_count: 1,
      first_unread_drop_serial_no: 1,
      latest_drop_serial_no: 1,
      latest_read_serial_no: 0,
      version: 1
    };
    const waveEntity = {
      id: 'wave-1',
      created_by: 'creator-1',
      is_direct_message: true,
      visibility_group_id: 'dm-group',
      participation_group_id: 'dm-group',
      chat_group_id: 'dm-group',
      admin_group_id: 'dm-group'
    };
    const wavesApiDb = {
      executeNativeQueriesInTransaction: jest.fn(async (callback) => {
        const result = await callback(connection);
        transactionCommitted = true;
        return result;
      }),
      insertWave: jest.fn().mockResolvedValue(undefined),
      insertOutcomes: jest.fn().mockResolvedValue(undefined),
      insertOutcomeDistributionItems: jest.fn().mockResolvedValue(undefined),
      updateDescriptionDropId: jest.fn().mockResolvedValue(undefined),
      findWaveById: jest.fn().mockResolvedValue(waveEntity),
      findDmUnreadConversationStatesForIdentities: jest
        .fn()
        .mockResolvedValue([dmUnreadState])
    };
    const userGroupsService = {
      findIdentitiesInGroups: jest
        .fn()
        .mockResolvedValue(['creator-1', 'recipient-1']),
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['dm-group']),
      onWaveRelatedGroupsChanged: jest.fn().mockResolvedValue(undefined)
    };
    const waveMappers = {
      createWaveToNewWaveEntity: jest.fn().mockResolvedValue(waveEntity),
      waveEntityToApiWave: jest.fn().mockResolvedValue({ id: 'wave-1' })
    };
    const activityRecorder = {
      recordWaveCreated: jest.fn().mockResolvedValue(undefined)
    };
    const identitySubscriptionsDb = {
      addIdentitySubscription: jest.fn().mockResolvedValue(undefined)
    };
    const createOrUpdateDrop = {
      execute: jest.fn().mockResolvedValue({
        drop_id: 'description-drop-1',
        pending_push_notification_ids: [],
        dm_unread_recipient_ids: ['recipient-1']
      })
    };
    const dropsMappers = {
      createDropApiToUseCaseModel: jest.fn().mockReturnValue({})
    };
    const userNotifier = {
      notifyOfWaveCreated: jest.fn().mockResolvedValue(undefined)
    };
    const metricsRecorder = {
      recordActiveIdentity: jest.fn().mockResolvedValue(undefined)
    };
    const waveGroupNotificationSubscriptionsDb = {
      addDefaultGroupsForWaveSubscription: jest
        .fn()
        .mockResolvedValue(undefined)
    };
    const wsListenersNotifier = {
      findConnectedNotificationRecipients: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', identityId: 'recipient-1' }
        ]),
      notifyAboutDmUnreadStateChanged: jest.fn(async () => {
        expect(transactionCommitted).toBe(true);
      })
    };
    const service = new WaveApiService(
      wavesApiDb as any,
      userGroupsService as any,
      waveMappers as any,
      activityRecorder as any,
      identitySubscriptionsDb as any,
      createOrUpdateDrop as any,
      dropsMappers as any,
      {} as any,
      {} as any,
      userNotifier as any,
      {} as any,
      metricsRecorder as any,
      {} as any,
      {} as any,
      waveGroupNotificationSubscriptionsDb as any,
      wsListenersNotifier as any
    );
    jest
      .spyOn(service as any, 'validateWaveRelations')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'validateOutcomes').mockReturnValue(undefined);
    jest
      .spyOn(service as any, 'validateSubwaveCreationParent')
      .mockResolvedValue(undefined);
    const timer = { start: jest.fn(), stop: jest.fn() };

    await expect(
      service.createWave(createWaveRequest(), true, {
        authenticationContext: AuthenticationContext.fromProfileId('creator-1'),
        timer: timer as any
      })
    ).resolves.toEqual({ id: 'wave-1' });

    expect(
      wavesApiDb.findDmUnreadConversationStatesForIdentities
    ).toHaveBeenCalledWith(
      { identityIds: ['recipient-1'], waveIds: ['wave-1'] },
      expect.objectContaining({ timer }),
      DbPoolName.WRITE
    );
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledWith(
      [dmUnreadState],
      [{ connectionId: 'connection-1', identityId: 'recipient-1' }]
    );
  });
});
