import { PUSH_NOTIFICATION_DEVICES_TABLE } from '../../../constants';
import { PushNotificationDevice } from '../../../entities/IPushNotification';
import { sqlExecutor } from '../../../sql-executor';

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
