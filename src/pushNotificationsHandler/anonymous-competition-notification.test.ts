import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  createCompetitionNotificationActorResolver,
  publicCompetitionNotificationActor
} from '@/pushNotificationsHandler/anonymous-competition-notification';

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

  it('loads one authoritative policy snapshot for all entry recipients in a batch', async () => {
    const hidden = jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set(['entry-drop', 'other-entry']));
    const notifications = Array.from({ length: 100 }, (_, index) => ({
      cause: IdentityNotificationCause.IDENTITY_MENTIONED,
      related_drop_id: index % 2 ? 'entry-drop' : 'other-entry'
    }));
    const ctx = {};
    const resolveActor = await createCompetitionNotificationActorResolver(
      notifications,
      ctx
    );
    const actors = notifications.map((notification) =>
      resolveActor(notification, identity)
    );

    expect(hidden).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledWith(['other-entry', 'entry-drop'], ctx, {
      includeOwner: true
    });
    expect(new Set(actors.map((actor) => actor.id)).size).toBe(2);
    expect(JSON.stringify(actors)).not.toContain('real-');
    expect(actors.every((actor) => actor.is_anonymous)).toBe(true);
  });
});
