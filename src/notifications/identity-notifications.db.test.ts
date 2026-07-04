import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { IdentityNotificationsDb } from './identity-notifications.db';
import { sendIdentityPushNotification } from '../api-serverless/src/push-notifications/push-notifications.service';

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
  return {
    db,
    identityMutesDb,
    repo: new IdentityNotificationsDb(() => db as any, identityMutesDb as any)
  };
}

describe('IdentityNotificationsDb mute filtering', () => {
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
});
