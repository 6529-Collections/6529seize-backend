import { PushInstallationEntity } from '@/entities/IPushInstallation';
import { In } from 'typeorm';
import { isIosPushPlatform } from './push-platform';
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
      profile_id: In(uniqueProfileIds)
    });
  const groups = new Map<string, PushNotificationDevice[]>();
  for (const device of devices) {
    if (!isIosPushPlatform(device.platform)) continue;
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
          // Remove all profiles using this invalid token, preserving rotated-token rows.
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

/** Resolve the current token even after all profile registration rows were deleted. */
export async function refreshInstallationBadge(
  deviceId: string
): Promise<void> {
  await withDeviceBadgeLock({ device_id: deviceId, token: '' }, async () => {
    const installation = await getDataSource()
      .getRepository(PushInstallationEntity)
      .findOneBy({ device_id: deviceId });
    if (!installation?.token || !isIosPushPlatform(installation.platform))
      return;
    const state = await getDeviceBadgeState({
      device_id: deviceId,
      token: installation.token
    });
    try {
      await sendBadgeUpdate(installation.token, state.count);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (
        code !== 'messaging/registration-token-not-registered' &&
        code !== 'messaging/invalid-registration-token'
      )
        throw error;
      // A rotated token may be registered concurrently; never remove that target.
      const target = { device_id: deviceId, token: installation.token };
      await getDataSource()
        .getRepository(PushNotificationDevice)
        .delete(target);
      await getDataSource()
        .getRepository(PushInstallationEntity)
        .update(target, { token: null });
    }
  });
}
