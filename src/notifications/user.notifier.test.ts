import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { UserNotifier } from '@/notifications/user.notifier';

describe('UserNotifier notifyWaveDropCreatedRecipients', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses reply, quote, mention, then all-drops precedence per recipient', async () => {
    const identityNotificationsDb = {
      findIdentitiesNotifiedForDropCreation: jest.fn().mockResolvedValue([]),
      insertManyNotifications: jest.fn().mockResolvedValue([1])
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);

    await notifier.notifyWaveDropCreatedRecipients(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: {
          reply_drop_id: 'drop-1',
          reply_drop_author_id: 'author-1',
          replied_drop_id: 'replied-drop',
          replied_drop_part: 1,
          replied_drop_author_id: 'reply-recipient',
          wave_id: 'wave-1'
        },
        quoteNotifications: [
          {
            quote_drop_id: 'drop-1',
            quote_drop_part: 1,
            quote_drop_author_id: 'author-1',
            quoted_drop_id: 'quoted-drop-1',
            quoted_drop_part: 1,
            quoted_drop_author_id: 'reply-recipient',
            wave_id: 'wave-1'
          },
          {
            quote_drop_id: 'drop-1',
            quote_drop_part: 2,
            quote_drop_author_id: 'author-1',
            quoted_drop_id: 'quoted-drop-2',
            quoted_drop_part: 1,
            quoted_drop_author_id: 'quote-recipient',
            wave_id: 'wave-1'
          },
          {
            quote_drop_id: 'drop-1',
            quote_drop_part: 3,
            quote_drop_author_id: 'author-1',
            quoted_drop_id: 'quoted-drop-3',
            quoted_drop_part: 1,
            quoted_drop_author_id: 'quote-recipient',
            wave_id: 'wave-1'
          }
        ],
        mentionedIdentityIds: [
          'reply-recipient',
          'quote-recipient',
          'mention-recipient',
          'author-1'
        ],
        allDropsSubscriberIds: [
          'reply-recipient',
          'quote-recipient',
          'mention-recipient',
          'all-drops-recipient',
          'author-1'
        ]
      },
      null,
      { connection: {} as any }
    );

    expect(
      identityNotificationsDb.findIdentitiesNotifiedForDropCreation
    ).toHaveBeenCalledWith('wave-1', 'drop-1', {});
    expect(
      identityNotificationsDb.insertManyNotifications
    ).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          identity_id: 'reply-recipient',
          cause: IdentityNotificationCause.DROP_REPLIED
        }),
        expect.objectContaining({
          identity_id: 'quote-recipient',
          cause: IdentityNotificationCause.DROP_QUOTED
        }),
        expect.objectContaining({
          identity_id: 'mention-recipient',
          cause: IdentityNotificationCause.IDENTITY_MENTIONED
        }),
        expect.objectContaining({
          identity_id: 'all-drops-recipient',
          cause: IdentityNotificationCause.ALL_DROPS
        })
      ],
      {}
    );
  });

  it('does not repeat any creation notification for an already notified recipient', async () => {
    const identityNotificationsDb = {
      findIdentitiesNotifiedForDropCreation: jest
        .fn()
        .mockResolvedValue(['existing-recipient']),
      insertManyNotifications: jest.fn().mockResolvedValue([1])
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);

    await notifier.notifyWaveDropCreatedRecipients(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: {
          reply_drop_id: 'drop-1',
          reply_drop_author_id: 'author-1',
          replied_drop_id: 'replied-drop',
          replied_drop_part: 1,
          replied_drop_author_id: 'existing-recipient',
          wave_id: 'wave-1'
        },
        quoteNotifications: [],
        mentionedIdentityIds: ['existing-recipient', 'new-recipient'],
        allDropsSubscriberIds: ['existing-recipient', 'new-recipient']
      },
      null,
      { connection: {} as any }
    );

    expect(
      identityNotificationsDb.insertManyNotifications
    ).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          identity_id: 'new-recipient',
          cause: IdentityNotificationCause.IDENTITY_MENTIONED
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

  it('skips self-vote notifications', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);

    await notifier.notifyOfDropVote(
      {
        voter_id: 'profile-1',
        drop_id: 'drop-1',
        drop_author_id: 'profile-1',
        vote: 171,
        vote_change: -1030,
        total_vote: 12345,
        wave_id: 'wave-1'
      },
      null,
      {} as any
    );

    expect(identityNotificationsDb.insertNotification).not.toHaveBeenCalled();
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

describe('UserNotifier notifyOfDropPollVote', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores selected poll options for the drop author', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);
    const connection = {} as any;

    await notifier.notifyOfDropPollVote(
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        drop_author_id: 'author-1',
        poll_options: [
          { option_no: 1, option_string: 'First' },
          { option_no: 3, option_string: 'Third' }
        ],
        wave_id: 'wave-1'
      },
      'visibility-group',
      connection
    );

    expect(identityNotificationsDb.insertNotification).toHaveBeenCalledWith(
      {
        identity_id: 'author-1',
        additional_identity_id: 'voter-1',
        related_drop_id: 'drop-1',
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.DROP_POLL_VOTED,
        additional_data: {
          poll_options: [
            { option_no: 1, option_string: 'First' },
            { option_no: 3, option_string: 'Third' }
          ]
        },
        wave_id: 'wave-1',
        visibility_group_id: 'visibility-group'
      },
      connection
    );
  });

  it('skips poll vote notifications for the author voting on their own poll', async () => {
    const identityNotificationsDb = {
      insertNotification: jest.fn()
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);

    await notifier.notifyOfDropPollVote(
      {
        voter_id: 'profile-1',
        drop_id: 'drop-1',
        drop_author_id: 'profile-1',
        poll_options: [{ option_no: 1, option_string: 'First' }],
        wave_id: 'wave-1'
      },
      null,
      {} as any
    );

    expect(identityNotificationsDb.insertNotification).not.toHaveBeenCalled();
  });
});
