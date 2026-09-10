import { In } from 'typeorm';
import { getDataSource } from '@/db';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { Logger } from '@/logging';
import {
  deviceBadgeKey,
  getDeviceBadgeState,
  withDeviceBadgeLock
} from './device-badge';
import { sendBadgeUpdate } from './sendPushNotifications';

const logger = Logger.get('PUSH_BADGE_REFRESH');

/** Return profiles whose work needs SQS retry, preserving successful device updates. */
export async function refreshProfileBadges(
  profileIds: string[]
): Promise<string[]> {
  const uniqueProfileIds = Array.from(new Set(profileIds));
  if (!uniqueProfileIds.length) return [];
  const failed = new Set<string>();
  const devices = await getDataSource()
    .getRepository(PushNotificationDevice)
    .findBy({
      profile_id: In(uniqueProfileIds),
      platform: 'ios'
    });
  const groups = new Map<string, PushNotificationDevice[]>();
  for (const device of devices) {
    const key = deviceBadgeKey(device);
    const group = groups.get(key) ?? [];
    group.push(device);
    groups.set(key, group);
  }
  await Promise.all(
    Array.from(groups.values()).map(async (registrations) => {
      const device = registrations[0];
      try {
        await withDeviceBadgeLock(device, async () => {
          const state = await getDeviceBadgeState(device);
          // A disconnect/token rotation may have happened while this job was queued.
          if (
            !registrations.some((row) => state.profileIds.has(row.profile_id))
          )
            return;
          await sendBadgeUpdate(device.token, state.count);
        });
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          // Match the exact old token, never delete a freshly rotated registration.
          await getDataSource().getRepository(PushNotificationDevice).delete({
            device_id: device.device_id,
            token: device.token
          });
          return;
        }
        logger.error(
          `Badge refresh failed for device ${device.device_id}: ${error}`
        );
        registrations.forEach((row) => failed.add(row.profile_id));
      }
    })
  );
  return Array.from(failed);
}
