import { requestDeviceBadgeRefresh } from '@/api/push-notifications/push-notifications.service';
import { invalidateWaveUnreadCacheForReaderWave } from '@/api/waves/wave-unread-cache';
import { NotificationsApiService } from '@/api/notifications/notifications.api.service';
import {
  isReadStateSyncEnabled,
  ReadStateNotifier,
  readStateMessage
} from '@/api/notifications/read-state-sync';
import { WsMessageType } from '@/api/ws/ws-message';
import { DbPoolName } from '@/db-query.options';

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  requestDeviceBadgeRefresh: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForReaderWave: jest.fn().mockResolvedValue(undefined)
}));

const PROFILE = 'profile-1';
const WAVE = 'wave-1';
const watermark = {
  latest_read_serial_no: 42,
  latest_read_timestamp: 9_000,
  version: 7
};
const recipients = [{ connectionId: 'conn-1', identityId: PROFILE }];

function setup({
  isDirectMessage = false,
  notificationsMarked = 0,
  changed = false,
  dmState = { wave_id: WAVE, profile_id: PROFILE, unread_count: 0 }
}: {
  isDirectMessage?: boolean;
  notificationsMarked?: number;
  changed?: boolean;
  dmState?: unknown;
} = {}) {
  const identityNotificationsDb = {
    markUnreadWaveNotificationsAsRead: jest
      .fn()
      .mockResolvedValue(notificationsMarked),
    markWaveNotificationsAsRead: jest.fn().mockResolvedValue(undefined)
  };
  const wavesApiDb = {
    findById: jest.fn().mockResolvedValue({
      id: WAVE,
      is_direct_message: isDirectMessage,
      visibility_group_id: null,
      parent_wave_id: null
    }),
    advanceWaveReadWatermark: jest
      .fn()
      .mockResolvedValue({ changed, watermark }),
    advanceDirectMessageReadWatermark: jest
      .fn()
      .mockResolvedValue({ changed, watermark }),
    findDmUnreadConversationStates: jest.fn().mockResolvedValue([dmState]),
    updateWaveReaderMetricLatestReadTimestamp: jest.fn(),
    markDirectMessageReadThroughSerial: jest.fn()
  };
  const wsListenersNotifier = {
    findConnectedNotificationRecipients: jest
      .fn()
      .mockResolvedValue(recipients),
    notifyAboutIdentityNotificationsChanged: jest
      .fn()
      .mockResolvedValue(undefined),
    notifyAboutDmUnreadStateChanged: jest.fn().mockResolvedValue(undefined)
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const readStateNotifier = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new NotificationsApiService(
    {} as never,
    userGroupsService as never,
    {} as never,
    {} as never,
    identityNotificationsDb as never,
    {} as never,
    wavesApiDb as never,
    {} as never,
    {} as never,
    {} as never,
    wsListenersNotifier as never,
    readStateNotifier
  );
  return {
    service,
    identityNotificationsDb,
    wavesApiDb,
    wsListenersNotifier,
    readStateNotifier
  };
}

describe('mark wave read with WS_READ_STATE_SYNC (waves plan 1.7)', () => {
  const previous = process.env.WS_READ_STATE_SYNC;
  beforeEach(() => {
    process.env.WS_READ_STATE_SYNC = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.WS_READ_STATE_SYNC;
    else process.env.WS_READ_STATE_SYNC = previous;
  });

  it('does nothing else when a read changes nothing', async () => {
    const { service, wsListenersNotifier, readStateNotifier } = setup();

    await expect(
      service.markWaveNotificationsAsRead(WAVE, PROFILE, {})
    ).resolves.toBeNull();

    expect(requestDeviceBadgeRefresh).not.toHaveBeenCalled();
    expect(invalidateWaveUnreadCacheForReaderWave).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.findConnectedNotificationRecipients
    ).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).not.toHaveBeenCalled();
    expect(readStateNotifier.notify).not.toHaveBeenCalled();
  });

  it('sends READ_STATE to the reader when the watermark moves', async () => {
    const { service, wavesApiDb, wsListenersNotifier, readStateNotifier } =
      setup({ changed: true });

    await service.markWaveNotificationsAsRead(WAVE, PROFILE, {});

    expect(wavesApiDb.advanceWaveReadWatermark).toHaveBeenCalledWith(
      { waveId: WAVE, readerId: PROFILE },
      {}
    );
    expect(invalidateWaveUnreadCacheForReaderWave).toHaveBeenCalledWith({
      identityId: PROFILE,
      waveId: WAVE
    });
    expect(readStateNotifier.notify).toHaveBeenCalledWith(
      { profile_id: PROFILE, wave_id: WAVE, ...watermark },
      recipients
    );
    // The notification count did not change: no badge, no invalidation frame.
    expect(requestDeviceBadgeRefresh).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).not.toHaveBeenCalled();
  });

  it('refreshes the badge and notification list only when notifications were read', async () => {
    const { service, wsListenersNotifier, readStateNotifier } = setup({
      notificationsMarked: 2
    });

    await service.markWaveNotificationsAsRead(WAVE, PROFILE, {});

    expect(requestDeviceBadgeRefresh).toHaveBeenCalledWith(PROFILE);
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).toHaveBeenCalledWith([PROFILE]);
    expect(readStateNotifier.notify).not.toHaveBeenCalled();
  });

  it('advances a DM through the requested serial and sends both DM state and READ_STATE', async () => {
    const dmState = { wave_id: WAVE, profile_id: PROFILE, unread_count: 0 };
    const { service, wavesApiDb, wsListenersNotifier, readStateNotifier } =
      setup({ isDirectMessage: true, changed: true, dmState });

    await service.markWaveNotificationsAsRead(WAVE, PROFILE, {}, 40);

    expect(wavesApiDb.advanceDirectMessageReadWatermark).toHaveBeenCalledWith(
      { waveId: WAVE, readerId: PROFILE, readThroughSerialNo: 40 },
      {}
    );
    expect(wavesApiDb.findDmUnreadConversationStates).toHaveBeenCalledWith(
      { identityId: PROFILE, eligibleGroups: [], waveIds: [WAVE] },
      {},
      DbPoolName.WRITE
    );
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledWith([dmState], recipients);
    expect(readStateNotifier.notify).toHaveBeenCalled();
  });

  it('still answers a requested DM state when nothing changed', async () => {
    const dmState = { wave_id: WAVE, profile_id: PROFILE, unread_count: 3 };
    const { service, wsListenersNotifier, readStateNotifier } = setup({
      isDirectMessage: true,
      dmState
    });

    await expect(
      service.markWaveNotificationsAsRead(WAVE, PROFILE, {}, 40, true)
    ).resolves.toBe(dmState);

    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).not.toHaveBeenCalled();
    expect(readStateNotifier.notify).not.toHaveBeenCalled();
  });

  it('keeps the previous behaviour when the flag is off', async () => {
    delete process.env.WS_READ_STATE_SYNC;
    const { service, identityNotificationsDb, wavesApiDb, readStateNotifier } =
      setup();

    await service.markWaveNotificationsAsRead(WAVE, PROFILE, {});

    expect(
      identityNotificationsDb.markWaveNotificationsAsRead
    ).toHaveBeenCalled();
    expect(
      wavesApiDb.updateWaveReaderMetricLatestReadTimestamp
    ).toHaveBeenCalled();
    expect(wavesApiDb.advanceWaveReadWatermark).not.toHaveBeenCalled();
    expect(requestDeviceBadgeRefresh).toHaveBeenCalledWith(PROFILE);
    expect(readStateNotifier.notify).not.toHaveBeenCalled();
  });
});

describe('ReadStateNotifier', () => {
  const data = { profile_id: PROFILE, wave_id: WAVE, ...watermark };

  it('sends one READ_STATE frame to each of the reader’s connections', async () => {
    const sockets = { send: jest.fn().mockResolvedValue({ status: 'sent' }) };
    const listeners = {
      findConnectedNotificationRecipients: jest.fn().mockResolvedValue([
        { connectionId: 'a', identityId: PROFILE },
        { connectionId: 'b', identityId: PROFILE },
        { connectionId: 'other', identityId: 'someone-else' }
      ])
    };
    const notifier = new ReadStateNotifier(listeners, sockets);

    await notifier.notify(data);

    const message = JSON.stringify({
      type: WsMessageType.READ_STATE,
      data
    });
    expect(sockets.send.mock.calls).toEqual([
      [{ connectionId: 'a', message }],
      [{ connectionId: 'b', message }]
    ]);
    expect(readStateMessage(data)).toEqual({ type: 'READ_STATE', data });
  });

  it('never fails the read when sending fails', async () => {
    const notifier = new ReadStateNotifier(
      {
        findConnectedNotificationRecipients: jest
          .fn()
          .mockRejectedValue(new Error('db down'))
      },
      { send: jest.fn() }
    );

    await expect(notifier.notify(data)).resolves.toBeUndefined();
  });

  it('is off unless WS_READ_STATE_SYNC is true', () => {
    const previous = process.env.WS_READ_STATE_SYNC;
    delete process.env.WS_READ_STATE_SYNC;
    expect(isReadStateSyncEnabled()).toBe(false);
    process.env.WS_READ_STATE_SYNC = 'true';
    expect(isReadStateSyncEnabled()).toBe(true);
    if (previous === undefined) delete process.env.WS_READ_STATE_SYNC;
    else process.env.WS_READ_STATE_SYNC = previous;
  });
});
