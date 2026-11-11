import { mock } from 'ts-jest-mocker';
import { identitiesDb } from '@/identities/identities.db';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { IdentityEntity } from '@/entities/IIdentity';
import { AppWebSockets } from './ws';
import { WsConnectionRepository } from './ws-connection.repository';
import { WsListenersNotifier } from './ws-listeners-notifier';

describe('typing fan-out', () => {
  const originalConcurrency = process.env.WS_FANOUT_CONCURRENCY;

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
    if (originalConcurrency === undefined) {
      delete process.env.WS_FANOUT_CONCURRENCY;
    } else {
      process.env.WS_FANOUT_CONCURRENCY = originalConcurrency;
    }
  });

  function notifierWithRecipients(count: number) {
    const repository = mock(WsConnectionRepository);
    repository.getCurrentlyOnlineCommunityMemberConnectionIds.mockResolvedValue(
      [
        {
          connectionId: 'sender-socket',
          profileId: 'sender',
          wave_id: 'wave',
          jwtExpiry: 0
        },
        ...Array.from({ length: count }, (_, i) => ({
          connectionId: `socket-${i}`,
          profileId: `viewer-${i}`,
          wave_id: 'wave',
          jwtExpiry: 0
        })),
        {
          connectionId: 'elsewhere',
          profileId: 'viewer-x',
          wave_id: 'other-wave',
          jwtExpiry: 0
        }
      ]
    );
    let inFlight = 0;
    let peak = 0;
    const send = jest.fn(
      async (_input: { connectionId: string; message: string }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
      }
    );
    const notifier = new WsListenersNotifier(
      { send } as unknown as AppWebSockets,
      repository
    );
    return { notifier, send, peak: () => peak };
  }

  it('keeps sends within the fan-out concurrency and reaches every recipient once', async () => {
    process.env.WS_FANOUT_CONCURRENCY = '4';
    const { notifier, send, peak } = notifierWithRecipients(50);

    await notifier.notifyAboutUserIsTyping({
      identityId: 'sender',
      waveId: 'wave'
    });

    expect(peak()).toBeLessThanOrEqual(4);
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
});
