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

    expect(db.execute.mock.calls[0]![0]).toContain(
      'select external_id from profiles'
    );
    expect(db.execute.mock.calls[0]![0]).toContain('for update');
    const [sql, params, options] = db.execute.mock.calls[1]!;
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
    expect(
      db.execute.mock.calls.every(
        ([, , queryOptions]) => queryOptions?.wrappedConnection === connection
      )
    ).toBe(true);
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('where profile_id = :profileId'),
      { profileId: 'profile-1' },
      { wrappedConnection: connection }
    );
  });

  it('locks stable recipient profile rows without creating preferences', async () => {
    const { connection, db, repository } = createRepository();
    db.execute.mockResolvedValueOnce([
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
      'join profiles profile_lock'
    );
    expect(db.execute.mock.calls[0]![0]).toContain('for update');
    expect(db.execute.mock.calls[0]![0]).not.toContain(
      'insert into profile_preferences'
    );
    expect(db.execute.mock.calls[0]![2]).toEqual({
      wrappedConnection: connection
    });
  });

  it('reads the group policy columns with legacy defaults for old rows', async () => {
    const { db, repository } = createRepository();
    db.oneOrNull.mockResolvedValueOnce({
      ...storedRow,
      direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
      direct_message_group_id: 'group-1',
      direct_message_allow_people_i_follow: 0
    });

    await expect(repository.get('profile-1')).resolves.toMatchObject({
      direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
      direct_message_group_id: 'group-1',
      direct_message_allow_people_i_follow: false
    });
    await expect(repository.get('profile-1')).resolves.toMatchObject({
      direct_message_group_id: null,
      direct_message_allow_people_i_follow: true
    });
  });

  it('updates the group policy columns only when supplied', async () => {
    const { db, repository } = createRepository();

    await repository.upsert('profile-1', {
      direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
      direct_message_group_id: 'group-1',
      direct_message_allow_people_i_follow: false
    });

    const [sql, params] = db.execute.mock.calls[1]!;
    const updateClause = sql.split('on duplicate key update')[1];
    expect(updateClause).toContain(
      'direct_message_group_id = :directMessageGroupId'
    );
    expect(updateClause).toContain(
      'direct_message_allow_people_i_follow = :directMessageAllowPeopleIFollow'
    );
    expect(params).toEqual(
      expect.objectContaining({
        directMessageGroupId: 'group-1',
        directMessageAllowPeopleIFollow: false
      })
    );

    db.execute.mockClear();
    await repository.upsert('profile-1', {
      direct_message_policy: ProfileDirectMessagePolicy.EVERYONE
    });
    const [plainSql] = db.execute.mock.calls[1]!;
    const plainUpdate = plainSql.split('on duplicate key update')[1];
    expect(plainUpdate).not.toContain('direct_message_group_id');
    expect(plainUpdate).not.toContain('direct_message_allow_people_i_follow');
  });

  it('reads blocks in both directions without disclosing them in the row shape', async () => {
    const { connection, db, repository } = createRepository();
    db.execute.mockResolvedValueOnce([
      {
        profile_id: 'recipient-profile',
        primary_address: '0xrecipient',
        handle: 'recipient',
        direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
        direct_message_group_id: 'group-1',
        direct_message_allow_people_i_follow: null,
        follows_creator: '1',
        recipient_blocked_creator: 1,
        creator_blocked_recipient: 0
      }
    ]);

    await expect(
      repository.getDirectMessageRecipientsByProfileIds(
        ['recipient-profile'],
        'creator-profile',
        connection,
        true
      )
    ).resolves.toEqual([
      {
        profile_id: 'recipient-profile',
        primary_address: '0xrecipient',
        handle: 'recipient',
        direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
        direct_message_group_id: 'group-1',
        direct_message_allow_people_i_follow: true,
        follows_creator: true,
        recipient_blocked_creator: true,
        creator_blocked_recipient: false
      }
    ]);

    const [sql, params] = db.execute.mock.calls[0]!;
    expect(sql).toContain('i.profile_id in (:profileIds)');
    expect(sql).not.toContain('i.primary_address in (:addresses)');
    expect(sql).toContain('content_moderation_profile_blocks rb');
    expect(sql).toContain('rb.blocker_profile_id = i.profile_id');
    expect(sql).toContain('cb.blocker_profile_id = :creatorProfileId');
    expect(sql).toContain('for update');
    expect(params).toEqual(
      expect.objectContaining({
        profileIds: ['recipient-profile'],
        creatorProfileId: 'creator-profile'
      })
    );
  });

  it('skips the query for an empty recipient list', async () => {
    const { db, repository } = createRepository();

    await expect(
      repository.getDirectMessageRecipientsByProfileIds([], 'creator-profile')
    ).resolves.toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
