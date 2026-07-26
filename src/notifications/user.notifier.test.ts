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

describe('UserNotifier notifyOfSubscriptionCoverage', () => {
  it('stores an actorless notification in the supplied transaction', async () => {
    const identityNotificationsDb = {
      insertManyNotifications: jest.fn().mockResolvedValue([77])
    };
    const notifier = new UserNotifier(identityNotificationsDb as any);
    const connection = {} as any;
    const data = {
      recipient_profile_id: 'stale-profile',
      profile_handle: 'alice',
      status: 'RUNNING_LOW' as const,
      consolidation_key: '0xabc-0xdef',
      mint_capacity: 3,
      allocated_mints: 3,
      fully_funded_drops: 3,
      funded_through: {
        token_id: 530,
        mint_at: '2026-08-17T00:00:00.000Z'
      },
      next_unfunded: {
        token_id: 531,
        mint_at: '2026-08-24T00:00:00.000Z',
        requested_mints: 1,
        funded_mints: 0,
        missing_mints: 1
      },
      minimum_top_up_eth: '0.06529',
      top_up_deadline: null,
      calculation_version: 1,
      forecast_fingerprint: 'risk-531-x1'
    };

    await expect(
      notifier.notifyOfSubscriptionCoverage('recipient-1', data, connection)
    ).resolves.toEqual([77]);

    expect(
      identityNotificationsDb.insertManyNotifications
    ).toHaveBeenCalledWith(
      [
        {
          identity_id: 'recipient-1',
          additional_identity_id: null,
          related_drop_id: null,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
          additional_data: {
            ...data,
            recipient_profile_id: 'recipient-1'
          },
          wave_id: null,
          visibility_group_id: null
        }
      ],
      connection
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
