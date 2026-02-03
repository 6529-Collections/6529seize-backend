import {
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE
} from '@/constants';
import { PushNotificationDevice } from '../../../entities/IPushNotification';
import { sqlExecutor } from '../../../sql-executor';
import { ApiPushNotificationDevice } from '../generated/models/ApiPushNotificationDevice';

export async function savePushNotificationDevice(
  device: PushNotificationDevice
) {
  await sqlExecutor.execute(
    `
      INSERT INTO ${PUSH_NOTIFICATION_DEVICES_TABLE} (device_id, token, profile_id, platform)
      VALUES (:device_id, :token, :profile_id, :platform)
      ON DUPLICATE KEY UPDATE token = VALUES(token), profile_id = VALUES(profile_id), platform = VALUES(platform)
    `,
    {
      device_id: device.device_id,
      token: device.token,
      profile_id: device.profile_id,
      platform: device.platform
    }
  );
}

export async function getDevicesForProfile(
  profileId: string
): Promise<ApiPushNotificationDevice[]> {
  return await sqlExecutor.execute(
    `
      SELECT device_id, platform, created_at, updated_at
      FROM ${PUSH_NOTIFICATION_DEVICES_TABLE}
      WHERE profile_id = :profile_id
      ORDER BY updated_at DESC
    `,
    { profile_id: profileId }
  );
}

export async function deleteDevice(
  profileId: string,
  deviceId: string
): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const params = { device_id: deviceId, profile_id: profileId };
    await sqlExecutor.execute(
      `DELETE FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = :device_id AND profile_id = :profile_id`,
      params,
      { wrappedConnection: connection }
    );
    await sqlExecutor.execute(
      `DELETE FROM ${PUSH_NOTIFICATION_SETTINGS_TABLE} WHERE device_id = :device_id AND profile_id = :profile_id`,
      params,
      { wrappedConnection: connection }
    );
  });
}
