import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import { SqlExecutor } from '@/sql-executor';
import { PushNotificationSettingsDb } from './push-notification-settings.db';

function createDb() {
  const execute = jest.fn(async () => []);
  const oneOrNull = jest.fn(async () => null);
  const executor = {
    execute,
    oneOrNull,
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn(() => 0)
  } as unknown as SqlExecutor;
  return {
    db: new PushNotificationSettingsDb(() => executor),
    execute,
    oneOrNull
  };
}

describe('PushNotificationSettingsDb', () => {
  it('returns default settings when a device has no stored row', async () => {
    const { db } = createDb();

    await expect(
      db.getPushNotificationSettings('profile-id', 'device-id')
    ).resolves.toEqual(DEFAULT_PUSH_NOTIFICATION_SETTINGS);
  });

  it('merges and persists a partial update', async () => {
    const { db, execute } = createDb();

    const result = await db.upsertPushNotificationSettings(
      'profile-id',
      'device-id',
      { subscription_coverage: false }
    );

    expect(result).toEqual({
      ...DEFAULT_PUSH_NOTIFICATION_SETTINGS,
      subscription_coverage: false
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('subscription_coverage'),
      {
        profileId: 'profile-id',
        deviceId: 'device-id',
        ...result
      }
    );
  });
});
