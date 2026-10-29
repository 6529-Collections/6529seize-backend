import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { publicCompetitionNotificationActor } from '@/pushNotificationsHandler/anonymous-competition-notification';

describe('anonymous competition push actor', () => {
  afterEach(() => jest.restoreAllMocks());

  const identity = {
    id: 'real-profile',
    handle: 'real-handle',
    normalised_handle: 'real-handle',
    primary_wallet: 'real-wallet',
    pfp: 'real-picture'
  } as ApiIdentity;

  it.each([
    IdentityNotificationCause.IDENTITY_MENTIONED,
    IdentityNotificationCause.DROP_QUOTED,
    IdentityNotificationCause.DROP_REPLIED,
    IdentityNotificationCause.ALL_DROPS,
    IdentityNotificationCause.PRIORITY_ALERT
  ])('redacts author identity before building %s push text', async (cause) => {
    const hidden = jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set(['entry-drop']));
    const result = await publicCompetitionNotificationActor(
      { cause, related_drop_id: 'entry-drop' },
      identity
    );
    expect(result).toMatchObject({ handle: 'Anonymous', pfp: null });
    expect(result.id).not.toBe(identity.id);
    expect(JSON.stringify(result)).not.toContain('real-');
    expect(hidden).toHaveBeenCalledWith(
      ['entry-drop'],
      {},
      { includeOwner: true }
    );
  });

  it('keeps voter identity when voting on an anonymous entry', async () => {
    const hidden = jest.spyOn(competitionAnonymityService, 'hiddenDropIds');
    await expect(
      publicCompetitionNotificationActor(
        {
          cause: IdentityNotificationCause.DROP_VOTED,
          related_drop_id: 'entry-drop'
        },
        identity
      )
    ).resolves.toBe(identity);
    expect(hidden).not.toHaveBeenCalled();
  });

  it('reveals the author after the entry wins', async () => {
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
    await expect(
      publicCompetitionNotificationActor(
        {
          cause: IdentityNotificationCause.ALL_DROPS,
          related_drop_id: 'winner'
        },
        identity
      )
    ).resolves.toBe(identity);
  });
});
