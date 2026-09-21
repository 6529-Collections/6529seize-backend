import { PushInstallationEntity } from '@/entities/IPushInstallation';
import { In } from 'typeorm';
import { isIosPushPlatform } from './push-platform';
import { getDataSource } from '@/db';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { reportPushDeliveryFailure } from '@/pushNotificationsHandler/push-send-diagnostics';
import {
  isPushTargetQuarantined,
  isSenderMismatch,
  quarantinePushTarget
} from '@/pushNotificationsHandler/push-delivery-state';
import {
  deviceBadgeKey,
  getDeviceBadgeState,
  withDeviceBadgeLock
} from './device-badge';
import { sendBadgeUpdate } from './sendPushNotifications';

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
  const groupsByDevice = new Map<string, PushNotificationDevice[][]>();
  for (const group of Array.from(groups.values())) {
    const deviceId = group[0].device_id;
    const deviceGroups = groupsByDevice.get(deviceId) ?? [];
    deviceGroups.push(group);
    groupsByDevice.set(deviceId, deviceGroups);
  }
  await Promise.all(
    Array.from(groupsByDevice.values()).map(async (deviceGroups) => {
      for (const registrations of deviceGroups) {
        await refreshTokenGroup(registrations, failed);
      }
    })
  );
  return Array.from(failed);
}

async function refreshTokenGroup(
  registrations: PushNotificationDevice[],
  failed: Set<string>
): Promise<void> {
  const device = registrations[0];
  try {
    await withDeviceBadgeLock(device, async () => {
      if (await isPushTargetQuarantined(device)) return;
      const state = await getDeviceBadgeState(device);
      // A disconnect/token rotation may have happened while this job was queued.
      if (!registrations.some((row) => state.profileIds.has(row.profile_id)))
        return;
      await sendOrQuarantine(device, state.count, 'badge_refresh');
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      // Remove all profiles using this invalid token, preserving rotated-token rows.
      try {
        await getDataSource().getRepository(PushNotificationDevice).delete({
          device_id: device.device_id,
          token: device.token
        });
      } catch (cleanupError) {
        reportPushDeliveryFailure(cleanupError, 'badge_refresh');
        registrations.forEach((row) => failed.add(row.profile_id));
      }
      return;
    }
    reportPushDeliveryFailure(error, 'badge_refresh');
    registrations.forEach((row) => failed.add(row.profile_id));
  }
}

/** Resolve the current token even after all profile registration rows were deleted. */
export async function refreshInstallationBadge(
  deviceId: string
): Promise<void> {
  await withDeviceBadgeLock({ device_id: deviceId }, async () => {
    const installation = await getDataSource()
      .getRepository(PushInstallationEntity)
      .findOneBy({ device_id: deviceId });
    if (!installation?.token || !isIosPushPlatform(installation.platform))
      return;
    const target = { device_id: deviceId, token: installation.token };
    if (await isPushTargetQuarantined(target)) return;
    const state = await getDeviceBadgeState(target);
    try {
      await sendOrQuarantine(target, state.count, 'installation_badge_refresh');
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

async function sendOrQuarantine(
  device: { device_id: string; token: string },
  count: number,
  stage: 'badge_refresh' | 'installation_badge_refresh'
): Promise<void> {
  try {
    await sendBadgeUpdate(device.token, count);
  } catch (error) {
    if (!isSenderMismatch(error)) throw error;
    // Quarantine must persist before acknowledging permanently incompatible work.
    await quarantinePushTarget(device);
    reportPushDeliveryFailure(error, stage);
  }
}
