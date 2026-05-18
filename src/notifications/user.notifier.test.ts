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

describe('UserNotifier notifyOfDropVote', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores vote change with the new vote total', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);
    const connection = {} as any;

    await notifier.notifyOfDropVote(
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        drop_author_id: 'author-1',
        vote: 171,
        vote_change: -1030,
        total_vote: 12345,
        wave_id: 'wave-1'
      },
      null,
      connection
    );

    expect(identityNotificationsDb.insertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: IdentityNotificationCause.DROP_VOTED,
        additional_data: {
          vote: 171,
          vote_change: -1030,
          total_vote: 12345
        }
      }),
      connection
    );
  });

  it('stores the rater REP rating', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);
    const connection = {} as any;

    await notifier.notifyOfIdentityRep(
      {
        rater_id: 'rater-1',
        rated_id: 'rated-1',
        amount: -1030,
        rater_rating: 171,
        total: 12345,
        category: 'Memes'
      },
      connection
    );

    expect(identityNotificationsDb.insertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: IdentityNotificationCause.IDENTITY_REP,
        additional_data: expect.objectContaining({
          rater_rating: 171
        })
      }),
      connection
    );
  });

  it('stores the rater NIC rating', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);
    const connection = {} as any;

    await notifier.notifyOfIdentityNic(
      {
        rater_id: 'rater-1',
        rated_id: 'rated-1',
        amount: -1030,
        rater_rating: 171,
        total: 12345
      },
      connection
    );

    expect(identityNotificationsDb.insertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: IdentityNotificationCause.IDENTITY_NIC,
        additional_data: expect.objectContaining({
          rater_rating: 171
        })
      }),
      connection
    );
  });
});
