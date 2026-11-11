import { mock } from 'ts-jest-mocker';
import { identitiesDb } from '@/identities/identities.db';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { IdentityEntity } from '@/entities/IIdentity';
import { AppWebSockets } from './ws';
import { WsConnectionRepository } from './ws-connection.repository';
import { WsListenersNotifier } from './ws-listeners-notifier';
import { WS_SEND_CONCURRENCY } from './ws-send-scheduler';

describe('typing fan-out', () => {
  beforeEach(() => {
    jest.spyOn(identitiesDb, 'getIdentityByProfileId').mockResolvedValue({
      profile_id: 'sender',
      handle: 'sender',
      level_raw: 0
    } as IdentityEntity);
    jest.spyOn(identitiesDb, 'getActiveMainStageDropIds').mockResolvedValue({});
    jest.spyOn(identitiesDb, 'getMainStageWinnerDropIds').mockResolvedValue({});
    jest.spyOn(identitiesDb, 'getArtistOfPrevoteCards').mockResolvedValue({});
    jest
      .spyOn(identitiesDb, 'getWaveCreatorProfileIds')
      .mockResolvedValue(new Set());
    jest
      .spyOn(profileWavesDb, 'findProfileWaveIdsByProfileIds')
      .mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function notifierWithRecipients(
    count: number,
    outcome: (connectionId: string) => unknown = () => undefined,
    includeSender = true
  ) {
    const repository = mock(WsConnectionRepository);
    repository.getCurrentlyOnlineCommunityMemberConnectionIds.mockResolvedValue(
      [
        ...(includeSender
          ? [
              {
                connectionId: 'sender-socket',
                profileId: 'sender',
                wave_id: 'wave'
              }
            ]
          : []),
        ...Array.from({ length: count }, (_, i) => ({
          connectionId: `socket-${i}`,
          profileId: `viewer-${i}`,
          wave_id: 'wave'
        })),
        {
          connectionId: 'elsewhere',
          profileId: 'viewer-x',
          wave_id: 'other-wave'
        }
      ]
    );
    let inFlight = 0;
    let peak = 0;
    const send = jest.fn(
      async (input: { connectionId: string; message: string }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return outcome(input.connectionId);
      }
    );
    const notifier = new WsListenersNotifier(
      { send } as unknown as AppWebSockets,
      repository
    );
    return { notifier, send, peak: () => peak };
  }

  it('keeps sends within the recipient pool and reaches every recipient once', async () => {
    const { notifier, send, peak } = notifierWithRecipients(50);

    await notifier.notifyAboutUserIsTyping({
      identityId: 'sender',
      waveId: 'wave'
    });

    expect(peak()).toBeLessThanOrEqual(WS_SEND_CONCURRENCY);
    const recipients = send.mock.calls.map(([input]) => input.connectionId);
    expect(new Set(recipients).size).toBe(51);
    expect(recipients).toContain('sender-socket');
    expect(recipients).not.toContain('elsewhere');
  });

  it('sends the same typing frame to every recipient', async () => {
    const { notifier, send } = notifierWithRecipients(5);

    await notifier.notifyAboutUserIsTyping({
      identityId: 'sender',
      waveId: 'wave'
    });

    const messages = new Set(send.mock.calls.map(([input]) => input.message));
    expect(messages.size).toBe(1);
    const frame = JSON.parse(Array.from(messages)[0]);
    expect(frame.type).toBe('USER_IS_TYPING');
    expect(frame.data.wave_id).toBe('wave');
    expect(frame.data.profile.id).toBe('sender');
  });

  it('reports a delivered typing frame', async () => {
    const { notifier } = notifierWithRecipients(2);

    await expect(
      notifier.notifyAboutUserIsTyping({ identityId: 'sender', waveId: 'wave' })
    ).resolves.toBe(true);
  });

  it('reports delivery when only some sends are accepted', async () => {
    const { notifier } = notifierWithRecipients(3, (id) =>
      id === 'socket-1' ? { status: 'sent' } : { status: 'gone' }
    );

    await expect(
      notifier.notifyAboutUserIsTyping({ identityId: 'sender', waveId: 'wave' })
    ).resolves.toBe(true);
  });

  it('reports delivery when a durable-capable recipient queued the frame', async () => {
    const { notifier } = notifierWithRecipients(2, () => ({
      status: 'resync_pending'
    }));

    await expect(
      notifier.notifyAboutUserIsTyping({ identityId: 'sender', waveId: 'wave' })
    ).resolves.toBe(true);
  });

  it.each(['gone', 'failed'])(
    'reports nothing delivered when every send is %s',
    async (status) => {
      const { notifier, send } = notifierWithRecipients(3, () => ({ status }));

      await expect(
        notifier.notifyAboutUserIsTyping({
          identityId: 'sender',
          waveId: 'wave'
        })
      ).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(4);
    }
  );

  it('rejects without sending when the sender is not in the wave audience', async () => {
    const { notifier, send } = notifierWithRecipients(3, undefined, false);

    await expect(
      notifier.notifyAboutUserIsTyping({ identityId: 'sender', waveId: 'wave' })
    ).rejects.toThrow('Wave not found');
    expect(send).not.toHaveBeenCalled();
  });
});
