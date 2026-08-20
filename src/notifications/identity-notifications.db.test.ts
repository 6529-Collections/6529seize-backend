import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { SqlExecutor } from '@/sql-executor';
import { IdentityNotificationsDb } from './identity-notifications.db';
import { sendIdentityPushNotification } from '../api-serverless/src/push-notifications/push-notifications.service';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationLevel
} from '@/entities/IProfilePreferences';

jest.mock(
  '../api-serverless/src/push-notifications/push-notifications.service',
  () => ({
    sendIdentityPushNotification: jest.fn()
  })
);

function notification(overrides: Record<string, unknown> = {}) {
  return {
    identity_id: 'recipient-1',
    additional_identity_id: 'actor-1',
    related_drop_id: null,
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null,
    wave_id: null,
    cause: IdentityNotificationCause.IDENTITY_MENTIONED,
    additional_data: {},
    visibility_group_id: null,
    ...overrides
  };
}

function createRepo({
  filteredNotifications,
  filterError
}: {
  readonly filteredNotifications: ReturnType<typeof notification>[];
  readonly filterError?: Error;
}) {
  const db = {
    execute: jest.fn().mockResolvedValue([undefined, undefined, 101]),
    bulkInsert: jest.fn()
  };
  const identityMutesDb = {
    filterMutedNotificationRows: jest.fn(
      filterError
        ? () => Promise.reject(filterError)
        : () => Promise.resolve(filteredNotifications)
    )
  };
  const profilePreferencesDb = {
    getMany: jest.fn().mockResolvedValue(new Map())
  };
  return {
    db,
    identityMutesDb,
    profilePreferencesDb,
    repo: new IdentityNotificationsDb(
      () => db as any,
      identityMutesDb as any,
      profilePreferencesDb as any
    )
  };
}

describe('IdentityNotificationsDb', () => {
  const originalNotifierActivated = process.env.USER_NOTIFIER_ACTIVATED;

  beforeEach(() => {
    process.env.USER_NOTIFIER_ACTIVATED = 'true';
    jest.mocked(sendIdentityPushNotification).mockClear();
  });

  afterEach(() => {
    process.env.USER_NOTIFIER_ACTIVATED = originalNotifierActivated;
    jest.restoreAllMocks();
  });

  it('does not insert a notification when the actor is muted', async () => {
    const row = notification();
    const { db, identityMutesDb, repo } = createRepo({
      filteredNotifications: []
    });

    await repo.insertNotification(row as any, {} as any);

    expect(identityMutesDb.filterMutedNotificationRows).toHaveBeenCalledWith(
      [row],
      {}
    );
    expect(db.execute).not.toHaveBeenCalled();
    expect(sendIdentityPushNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['follow', IdentityNotificationCause.IDENTITY_SUBSCRIBED],
    ['reply', IdentityNotificationCause.DROP_REPLIED]
  ])(
    'does not insert a %s notification from a muted actor',
    async (_label, cause) => {
      const row = notification({ cause });
      const { db, identityMutesDb, repo } = createRepo({
        filteredNotifications: []
      });

      await repo.insertNotification(row as any, {} as any);

      expect(identityMutesDb.filterMutedNotificationRows).toHaveBeenCalledWith(
        [row],
        {}
      );
      expect(db.execute).not.toHaveBeenCalled();
      expect(sendIdentityPushNotification).not.toHaveBeenCalled();
    }
  );

  it('bulk inserts only unmuted notifications', async () => {
    const mutedRow = notification({ identity_id: 'recipient-1' });
    const unmutedRow = notification({ identity_id: 'recipient-2' });
    const { db, repo } = createRepo({
      filteredNotifications: [unmutedRow]
    });
    db.execute.mockResolvedValueOnce([{ id: 301 }]);
    db.execute.mockResolvedValueOnce([{ id: 301 }]);

    await expect(
      repo.insertManyNotifications([mutedRow, unmutedRow] as any, {} as any)
    ).resolves.toEqual([301]);

    expect(db.bulkInsert).toHaveBeenCalledWith(
      'identity_notifications',
      [
        expect.objectContaining({
          identity_id: 'recipient-2',
          additional_identity_id: 'actor-1',
          additional_data: '{}'
        })
      ],
      expect.any(Array),
      undefined,
      { connection: {} }
    );
    expect(db.execute).toHaveBeenNthCalledWith(
      1,
      'select last_insert_id() as id',
      undefined,
      { wrappedConnection: {} }
    );
    expect(db.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        '`additional_data` <=> CAST(:additional_data_0 AS JSON)'
      ),
      expect.objectContaining({
        firstInsertId: 301,
        identity_id_0: 'recipient-2',
        additional_identity_id_0: 'actor-1',
        additional_data_0: '{}'
      }),
      { wrappedConnection: {} }
    );
  });

  it('fails open when mute filtering fails on the write path', async () => {
    const row = notification();
    const { db, repo } = createRepo({
      filteredNotifications: [],
      filterError: new Error('mute table unavailable')
    });
    db.execute.mockResolvedValueOnce([undefined, undefined, 401]);

    await repo.insertNotification(row as any, {} as any);

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('insert into identity_notifications'),
      expect.objectContaining({
        identity_id: 'recipient-1',
        additional_identity_id: 'actor-1',
        additional_data: '{}'
      }),
      { wrappedConnection: {} }
    );
    expect(sendIdentityPushNotification).toHaveBeenCalledWith(401);
  });

  it('keeps actorless system notifications on the write path', async () => {
    const row = notification({
      additional_identity_id: null,
      cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE
    });
    const { db, identityMutesDb, repo } = createRepo({
      filteredNotifications: [row]
    });

    await repo.insertNotification(row as any, {} as any);

    expect(identityMutesDb.filterMutedNotificationRows).toHaveBeenCalledWith(
      [row],
      {}
    );
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('insert into identity_notifications'),
      expect.objectContaining({
        additional_identity_id: null,
        cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE
      }),
      { wrappedConnection: {} }
    );
  });

  it('does not create in-app or push notifications disabled by profile preferences', async () => {
    const row = notification({
      cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE
    });
    const { db, profilePreferencesDb, repo } = createRepo({
      filteredNotifications: [row]
    });
    profilePreferencesDb.getMany.mockResolvedValue(
      new Map([
        [
          'recipient-1',
          {
            ...DEFAULT_PROFILE_PREFERENCES,
            notifications: {
              ...DEFAULT_PROFILE_PREFERENCES.notifications,
              subscription_coverage: false
            }
          }
        ]
      ])
    );

    await repo.insertNotification(row as any, {} as any);

    expect(db.execute).not.toHaveBeenCalled();
    expect(sendIdentityPushNotification).not.toHaveBeenCalled();
  });

  it('pauses optional notifications at the essential-only level without erasing category choices', async () => {
    const row = notification();
    const { db, profilePreferencesDb, repo } = createRepo({
      filteredNotifications: [row]
    });
    profilePreferencesDb.getMany.mockResolvedValue(
      new Map([
        [
          'recipient-1',
          {
            ...DEFAULT_PROFILE_PREFERENCES,
            notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
          }
        ]
      ])
    );

    await repo.insertNotification(row as any, {} as any);

    expect(db.execute).not.toHaveBeenCalled();
    expect(sendIdentityPushNotification).not.toHaveBeenCalled();
  });

  it('includes actorless notifications while suppressing orphaned actors', async () => {
    const db = {
      execute: jest.fn().mockResolvedValue([])
    };
    const repo = new IdentityNotificationsDb(() => db as any);

    await repo.findNotifications({
      identity_id: 'recipient-1',
      id_less_than: null,
      limit: 20,
      eligible_group_ids: [],
      cause: null,
      cause_exclude: null,
      unread_only: false
    });

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('n.additional_identity_id IS NULL'),
      expect.objectContaining({ identity_id: 'recipient-1' }),
      undefined
    );
    expect(db.execute.mock.calls[0][0]).toContain(
      'WHERE i.profile_id = n.additional_identity_id'
    );
    expect(db.execute.mock.calls[0][0]).not.toContain(
      'JOIN identities i ON n.additional_identity_id'
    );
  });

  it('counts only unread notifications visible to the recipient', async () => {
    const db = {
      oneOrNull: jest.fn().mockResolvedValue({ cnt: 2 })
    };
    const repo = new IdentityNotificationsDb(() => db as any);

    await expect(
      repo.countUnreadNotificationsForIdentity(
        'recipient-1',
        ['private-group'],
        undefined,
        { enabledCauses: [IdentityNotificationCause.IDENTITY_MENTIONED] }
      )
    ).resolves.toBe(2);

    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.not.stringContaining('includeNotificationId'),
      expect.objectContaining({
        identity_id: 'recipient-1',
        eligibleGroupIds: ['private-group']
      }),
      undefined
    );
  });

  it('uses private DM membership and wave mute state when reading the notification feed', async () => {
    const db: Partial<SqlExecutor> = {
      execute: jest.fn().mockResolvedValue([])
    };
    const repo = new IdentityNotificationsDb(() => db as SqlExecutor);

    await repo.findNotifications({
      identity_id: 'phoebeumzz',
      id_less_than: null,
      limit: 20,
      eligible_group_ids: ['dm-phoebeumzz-prxt0-notprxt0'],
      cause: null,
      cause_exclude: null,
      unread_only: false
    });

    const execute = jest.mocked(db.execute!);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('OR n.visibility_group_id IN (:eligible_group_ids)');
    expect(sql).toContain('AND COALESCE(r.muted, FALSE) = FALSE');
    expect(sql).toContain('AND m.id IS NULL');
    expect(params).toEqual(
      expect.objectContaining({
        identity_id: 'phoebeumzz',
        eligible_group_ids: ['dm-phoebeumzz-prxt0-notprxt0']
      })
    );
  });

  it('finds only recipients already notified about a drop creation', async () => {
    const db = {
      execute: jest
        .fn()
        .mockResolvedValue([
          { identity_id: 'recipient-1' },
          { identity_id: 'recipient-2' }
        ])
    };
    const repo = new IdentityNotificationsDb(() => db as any);

    await expect(
      repo.findIdentitiesNotifiedForDropCreation('wave-1', 'drop-1', {} as any)
    ).resolves.toEqual(['recipient-1', 'recipient-2']);

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('related_drop_id = :dropId'),
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        causes: [
          IdentityNotificationCause.DROP_REPLIED,
          IdentityNotificationCause.DROP_QUOTED,
          IdentityNotificationCause.IDENTITY_MENTIONED,
          IdentityNotificationCause.ALL_DROPS
        ]
      },
      { wrappedConnection: {} }
    );
    expect(db.execute.mock.calls[0][0]).not.toContain('related_drop_2_id');
  });
});
