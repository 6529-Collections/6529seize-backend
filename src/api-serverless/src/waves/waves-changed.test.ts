import { ApiWaveSubscriptionTargetAction } from '@/api/generated/models/ApiWaveSubscriptionTargetAction';
import { WsMessageType } from '@/api/ws/ws-message';
import {
  wavesChangedNotifier,
  WavesChangedNotifier
} from './waves-changed.notifier';
import { WaveApiService } from './wave.api.service';

describe('WavesChangedNotifier (waves 1.3)', () => {
  it('sends WAVES_CHANGED to every connection of each changed profile', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const notifier = new WavesChangedNotifier(
      {
        findNotificationConnectionIdsByIdentityIds: jest
          .fn()
          .mockResolvedValue([
            { connectionId: 'tab-1', identityId: 'alice', jwtExpiry: 10 },
            { connectionId: 'tab-2', identityId: 'alice', jwtExpiry: 11 },
            // A connection that syncs alice as a notification identity.
            { connectionId: 'other-app', identityId: 'alice', jwtExpiry: 12 },
            { connectionId: 'bob-tab', identityId: 'bob', jwtExpiry: 13 }
          ])
      },
      { send }
    );

    await notifier.notify([
      { profileId: 'alice', waveIds: ['w1'], reason: 'FOLLOWED' },
      { profileId: 'bob', waveIds: ['w1'], reason: 'ADDED' }
    ]);

    const sent = send.mock.calls.map(([args]) => ({
      connectionId: args.connectionId,
      jwtExpiry: args.jwtExpiry,
      message: JSON.parse(args.message)
    }));
    expect(sent).toEqual([
      ...['tab-1', 'tab-2', 'other-app'].map((connectionId, i) => ({
        connectionId,
        jwtExpiry: 10 + i,
        message: {
          type: WsMessageType.WAVES_CHANGED,
          data: { profile_id: 'alice', wave_ids: ['w1'], reason: 'FOLLOWED' }
        }
      })),
      {
        connectionId: 'bob-tab',
        jwtExpiry: 13,
        message: {
          type: WsMessageType.WAVES_CHANGED,
          data: { profile_id: 'bob', wave_ids: ['w1'], reason: 'ADDED' }
        }
      }
    ]);
  });

  it('does nothing without changes and never throws', async () => {
    const lookup = jest.fn().mockRejectedValue(new Error('db down'));
    const notifier = new WavesChangedNotifier(
      { findNotificationConnectionIdsByIdentityIds: lookup },
      { send: jest.fn() }
    );

    await notifier.notify([]);
    await notifier.notify([
      { profileId: 'alice', waveIds: [], reason: 'ADDED' }
    ]);
    expect(lookup).not.toHaveBeenCalled();

    await expect(
      notifier.notify([
        { profileId: 'alice', waveIds: ['w1'], reason: 'UNFOLLOWED' }
      ])
    ).resolves.toBeUndefined();
  });
});

describe('WaveApiService follow and unfollow send WAVES_CHANGED', () => {
  let notify: jest.SpyInstance;
  beforeEach(() => {
    notify = jest
      .spyOn(wavesChangedNotifier, 'notify')
      .mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function service(active: ApiWaveSubscriptionTargetAction[]) {
    const svc = Object.create(WaveApiService.prototype) as WaveApiService;
    jest
      .spyOn(svc as any, 'addWaveSubscriptionActionsInTransaction')
      .mockResolvedValue(active);
    jest
      .spyOn(svc as any, 'removeWaveSubscriptionActionsInTransaction')
      .mockResolvedValue(active);
    return svc;
  }

  it('sends FOLLOWED after a follow commits', async () => {
    const svc = service([ApiWaveSubscriptionTargetAction.DropCreated]);

    await expect(
      svc.addWaveSubscriptionActions({
        subscriber: 'alice',
        waveId: 'w1',
        actions: [ApiWaveSubscriptionTargetAction.DropCreated]
      })
    ).resolves.toEqual([ApiWaveSubscriptionTargetAction.DropCreated]);
    expect(notify).toHaveBeenCalledWith([
      { profileId: 'alice', waveIds: ['w1'], reason: 'FOLLOWED' }
    ]);
  });

  it('sends UNFOLLOWED after an unfollow commits', async () => {
    const svc = service([]);

    await svc.removeWaveSubscriptionActions({
      subscriber: 'alice',
      waveId: 'w1',
      actions: [ApiWaveSubscriptionTargetAction.DropCreated]
    });
    expect(notify).toHaveBeenCalledWith([
      { profileId: 'alice', waveIds: ['w1'], reason: 'UNFOLLOWED' }
    ]);
  });

  it('sends nothing when the follow state did not change', async () => {
    // Removing another action while still following.
    const svc = service([ApiWaveSubscriptionTargetAction.DropCreated]);
    await svc.removeWaveSubscriptionActions({
      subscriber: 'alice',
      waveId: 'w1',
      actions: []
    });
    // Adding no follow action.
    await svc.addWaveSubscriptionActions({
      subscriber: 'alice',
      waveId: 'w1',
      actions: []
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
