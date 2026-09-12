import { createHash, randomUUID } from 'node:crypto';
import { getDataSource } from '@/db';
import { DbPoolName } from '@/db-query.options';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import {
  DEFAULT_PUSH_NOTIFICATION_SETTINGS,
  PushNotificationSettingsEntity
} from '@/entities/IPushNotificationSettings';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { getRedisClient } from '@/redis';
import { Logger } from '@/logging';
import { getEnabledCauses } from './identity-push-notification-settings';
import { sumBadgeContributions } from './badge-count';

const logger = Logger.get('DEVICE_BADGE');

export type BadgeDevice = Pick<PushNotificationDevice, 'device_id' | 'token'>;

/** Group delivery targets by device/token; the coordination lock spans the entire device. */
export function deviceBadgeKey(device: BadgeDevice): string {
  return createHash('sha256')
    .update(JSON.stringify([device.device_id, device.token]))
    .digest('hex');
}

/** Serialize count + submission for both ordinary iOS pushes and badge refreshes. */
export async function withDeviceBadgeLock<T>(
  device: BadgeDevice,
  action: () => Promise<T>
): Promise<T> {
  const redis = getRedisClient();
  if (!redis) throw new Error('Badge delivery requires Redis coordination');
  const key = `push-badge-lock:${createHash('sha256').update(device.device_id).digest('hex')}`;
  const owner = randomUUID();
  // Longer than the push worker's 60-second Lambda timeout. Busy jobs retry via SQS.
  const acquired = await redis.set(key, owner, { NX: true, EX: 120 });
  if (!acquired) throw new Error('Device badge delivery is busy');
  try {
    return await action();
  } finally {
    try {
      await redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [owner] }
      );
    } catch (error) {
      // Expiry releases a stranded lock; never replay a delivered alert just for cleanup.
      logger.error(`Failed to release device badge lock: ${error}`);
    }
  }
}

/** Count the whole device from the primary and return only profiles still using this token. */
export async function getDeviceBadgeState(device: BadgeDevice): Promise<{
  count: number;
  profileIds: Set<string>;
}> {
  const registrations = await getDataSource()
    .getRepository(PushNotificationDevice)
    .findBy({ device_id: device.device_id });
  const profileIds = new Set(
    registrations
      .filter((row) => row.token === device.token)
      .map((row) => row.profile_id)
  );
  if (!registrations.length) return { count: 0, profileIds };
  // Token rotation may update connected profiles at different times. Count the whole device.
  const connectedProfileIds = new Set(
    registrations.map((row) => row.profile_id)
  );
  const contributions = await Promise.allSettled(
    Array.from(connectedProfileIds).map(async (profileId) => {
      const settings = await getDataSource()
        .getRepository(PushNotificationSettingsEntity)
        .findOneBy({ profile_id: profileId, device_id: device.device_id });
      const enabledCauses = getEnabledCauses(
        settings ?? DEFAULT_PUSH_NOTIFICATION_SETTINGS
      );
      if (!enabledCauses.length) return 0;
      const groups =
        await userGroupsService.getGroupsUserIsEligibleFor(profileId);
      return identityNotificationsDb.countUnreadNotificationsForIdentity(
        profileId,
        groups,
        undefined,
        { enabledCauses, forcePool: DbPoolName.WRITE }
      );
    })
  );
  return { count: sumBadgeContributions(contributions), profileIds };
}
