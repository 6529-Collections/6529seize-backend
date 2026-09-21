import { getDataSource } from '@/db';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { reportPushDeliveryFailure } from '@/pushNotificationsHandler/push-send-diagnostics';
import {
  deliveredPushIds,
  recordDeliveredPush,
  isPushTargetQuarantined,
  isSenderMismatch,
  quarantinePushTarget
} from '@/pushNotificationsHandler/push-delivery-state';
import { isIosPushPlatform } from './push-platform';
import {
  deviceBadgeKey,
  getDeviceBadgeState,
  withDeviceBadgeLock
} from './device-badge';
import {
  sendMessages,
  type PushNotificationMessageInput,
  type PushNotificationSendResult
} from './sendPushNotifications';

export interface IdentityPushNotificationMessage {
  input: PushNotificationMessageInput;
  identityId: string;
  device: PushNotificationDevice;
}

type ResultHandler = (
  messages: IdentityPushNotificationMessage[],
  results: PushNotificationSendResult[]
) => Promise<number[]>;

function groupByDevice(messages: IdentityPushNotificationMessage[]) {
  const groups = new Map<string, IdentityPushNotificationMessage[]>();
  for (const message of messages) {
    const key = deviceBadgeKey(message.device);
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  const byDevice = new Map<string, IdentityPushNotificationMessage[][]>();
  for (const group of Array.from(groups.values())) {
    const deviceId = group[0].device.device_id;
    const siblings = byDevice.get(deviceId) ?? [];
    siblings.push(group);
    byDevice.set(deviceId, siblings);
  }
  return Array.from(byDevice.values());
}

async function currentMessages(group: IdentityPushNotificationMessage[]) {
  const device = group[0].device;
  const ios = isIosPushPlatform(device.platform);
  const state = ios
    ? await getDeviceBadgeState(device)
    : {
        count: 0,
        profileIds: new Set(
          (
            await getDataSource().getRepository(PushNotificationDevice).findBy({
              device_id: device.device_id,
              token: device.token
            })
          ).map((row) => row.profile_id)
        )
      };
  return group
    .filter((message) => state.profileIds.has(message.identityId))
    .map((message) => ({
      ...message,
      input: ios
        ? { ...message.input, badge: state.count }
        : { ...message.input, omitBadge: true }
    }));
}

async function sendPending(
  current: IdentityPushNotificationMessage[],
  handleSendResults: ResultHandler
): Promise<number[]> {
  if (!current.length) return [];
  const device = current[0].device;
  const delivered = await deliveredPushIds(
    device.device_id,
    current.map((message) => message.input.notification_id)
  );
  const pending = current.filter(
    (message) => !delivered.has(message.input.notification_id)
  );
  if (!pending.length) return [];
  const results = await sendMessages(pending.map((message) => message.input));
  await Promise.all(
    results
      .filter((result) => result.response.success)
      .map((result) =>
        recordDeliveredPush(device.device_id, result.input.notification_id)
      )
  );
  if (results.some((result) => isSenderMismatch(result.response.error))) {
    await quarantinePushTarget(device);
  }
  const retryable = results.flatMap((result, index) =>
    isSenderMismatch(result.response.error)
      ? []
      : [{ result, message: pending[index] }]
  );
  return handleSendResults(
    retryable.map((item) => item.message),
    retryable.map((item) => item.result)
  );
}

async function sendGroup(
  group: IdentityPushNotificationMessage[],
  handleSendResults: ResultHandler
): Promise<number[]> {
  const device = group[0].device;
  try {
    return await withDeviceBadgeLock(device, async () => {
      if (await isPushTargetQuarantined(device)) return [];
      return sendPending(await currentMessages(group), handleSendResults);
    });
  } catch (error) {
    reportPushDeliveryFailure(error, 'delivery');
    return group.map((message) => message.input.notification_id);
  }
}

export async function sendIdentityPushGroups(
  messages: IdentityPushNotificationMessage[],
  handleSendResults: ResultHandler
): Promise<number[]> {
  // Serialize token variants within a device; independent devices can progress together.
  const failed = await Promise.all(
    groupByDevice(messages).map(async (groups) => {
      const ids: number[] = [];
      for (const group of groups)
        ids.push(...(await sendGroup(group, handleSendResults)));
      return ids;
    })
  );
  return Array.from(new Set(failed.flat()));
}
