import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileDirectMessagePolicy,
  ProfileNotificationLevel
} from '@/entities/IProfilePreferences';
import { ProfilePreferencesDb } from './profile-preferences.db';

const storedRow = {
  profile_id: 'profile-1',
  direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
  notification_level: ProfileNotificationLevel.ALL,
  notify_direct_messages: true,
  notify_mentions_replies_quotes: true,
  notify_reactions_votes_boosts: true,
  notify_new_followers: true,
  notify_rep_and_nic: true,
  notify_subscription_coverage: false
};

function createRepository() {
  const connection = { id: 'transaction' } as any;
  const db = {
    execute: jest.fn(),
    oneOrNull: jest.fn().mockResolvedValue(storedRow),
    executeNativeQueriesInTransaction: jest.fn(async (callback) =>
      callback(connection)
    )
  };
  return {
    connection,
    db,
    repository: new ProfilePreferencesDb(() => db as any)
  };
}

describe('ProfilePreferencesDb', () => {
  it('atomically updates only supplied preference columns', async () => {
    const { connection, db, repository } = createRepository();

    await expect(
      repository.upsert('profile-1', {
        notifications: { subscription_coverage: false }
      })
    ).resolves.toEqual({
      ...DEFAULT_PROFILE_PREFERENCES,
      notifications: {
        ...DEFAULT_PROFILE_PREFERENCES.notifications,
        subscription_coverage: false
      }
    });

    const [sql, params, options] = db.execute.mock.calls[0]!;
    const updateClause = sql.split('on duplicate key update')[1];
    expect(updateClause).toContain(
      'notify_subscription_coverage = :subscriptionCoverage'
    );
    expect(updateClause).not.toContain('direct_message_policy');
    expect(updateClause).not.toContain('notify_direct_messages');
    expect(params).toEqual(
      expect.objectContaining({
        profileId: 'profile-1',
        directMessagePolicy: ProfileDirectMessagePolicy.EVERYONE,
        notificationLevel: ProfileNotificationLevel.ALL,
        subscriptionCoverage: false
      })
    );
    expect(options).toEqual({ wrappedConnection: connection });
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('where profile_id = :profileId'),
      { profileId: 'profile-1' },
      { wrappedConnection: connection }
    );
  });

  it('creates and locks default recipient rows before admission', async () => {
    const { connection, db, repository } = createRepository();
    db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        profile_id: 'recipient-profile',
        primary_address: '0xrecipient',
        handle: 'recipient',
        direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
        follows_creator: 0
      }
    ]);

    await expect(
      repository.getDirectMessageRecipientsForAdmission(
        ['0xrecipient'],
        'creator-profile',
        connection
      )
    ).resolves.toEqual([
      expect.objectContaining({
        profile_id: 'recipient-profile',
        follows_creator: false
      })
    ]);

    expect(db.execute.mock.calls[0]![0]).toContain(
      'insert into profile_preferences'
    );
    expect(db.execute.mock.calls[1]![0]).toContain('for update');
    expect(db.execute.mock.calls[1]![2]).toEqual({
      wrappedConnection: connection
    });
  });
});
