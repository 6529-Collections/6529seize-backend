import { getDataSource } from '@/db';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { Logger } from '@/logging';
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

const logger = Logger.get('PUSH_NOTIFICATIONS_DELIVERY');

export async function sendIdentityPushGroups(
  messages: IdentityPushNotificationMessage[],
  handleSendResults: (
    messages: IdentityPushNotificationMessage[],
    results: PushNotificationSendResult[]
  ) => Promise<number[]>
): Promise<number[]> {
  const failedIds: number[] = [];
  // iOS alerts and refresh jobs share a device lock; calculate immediately before send.
  const groups = new Map<string, IdentityPushNotificationMessage[]>();
  for (const message of messages) {
    const key = deviceBadgeKey(message.device);
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const send = async (current: IdentityPushNotificationMessage[]) => {
        if (!current.length) return;
        const results = await sendMessages(
          current.map((message) => message.input)
        );
        failedIds.push(...(await handleSendResults(current, results)));
      };
      try {
        const device = group[0].device;
        await withDeviceBadgeLock(device, async () => {
          const ios = isIosPushPlatform(device.platform);
          const state = ios
            ? await getDeviceBadgeState(device)
            : {
                count: 0,
                profileIds: new Set(
                  (
                    await getDataSource()
                      .getRepository(PushNotificationDevice)
                      .findBy({
                        device_id: device.device_id,
                        token: device.token
                      })
                  ).map((row) => row.profile_id)
                )
              };
          await send(
            group
              .filter((message) => state.profileIds.has(message.identityId))
              .map((message) => ({
                ...message,
                input: ios
                  ? { ...message.input, badge: state.count }
                  : { ...message.input, omitBadge: true }
              }))
          );
        });
      } catch (error) {
        logger.error(`Failed to send notification group: ${error}`);
        failedIds.push(
          ...group.map((message) => message.input.notification_id)
        );
      }
    })
  );

  return Array.from(new Set(failedIds));
}
