import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { UserNotifier } from '@/notifications/user.notifier';

describe('UserNotifier notifyWaveDropCreatedRecipients', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips all-drops notifications for identities already notified about the drop', async () => {
    const identityNotificationsDb = {
      findIdentitiesNotification: jest.fn().mockResolvedValue(['reply-author']),
      insertManyNotifications: jest.fn().mockResolvedValue([1])
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);

    await notifier.notifyWaveDropCreatedRecipients(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        mentionedIdentityIds: ['mentioned-1'],
        allDropsSubscriberIds: ['reply-author', 'all-drops-1']
      },
      null,
      { connection: {} as any }
    );

    expect(
      identityNotificationsDb.findIdentitiesNotification
    ).toHaveBeenCalledWith('wave-1', 'drop-1', {});
    expect(
      identityNotificationsDb.insertManyNotifications
    ).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          identity_id: 'mentioned-1',
          cause: IdentityNotificationCause.IDENTITY_MENTIONED
        }),
        expect.objectContaining({
          identity_id: 'all-drops-1',
          cause: IdentityNotificationCause.ALL_DROPS
        })
      ],
      {}
    );
  });
});
