import {
  IDENTITIES_TABLE,
  PUSH_NOTIFICATION_DEVICES_TABLE
} from '@/constants/db-tables';
import {
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import { Logger } from '@/logging';
import { profilePreferencesDb } from '@/profile-preferences/profile-preferences.db';
import {
  PushNotificationMessageInput,
  PushNotificationSendResult,
  sendMessages
} from '@/pushNotificationsHandler/sendPushNotifications';
import { dbSupplier } from '@/sql-executor';
import { buildMultiProfileTitlePrefix } from './multi-profile-push-title';

// Content-free wakes for end-to-end encrypted messaging (D109 contract v1,
// section 7.3). A wake says only that something encrypted arrived for the
// recipient profile: no sender, group handle, text or image.

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_E2EE');

export type E2eeWakeReason = 'message' | 'added';

const E2EE_WAKE_COPY = {
  message: { title: 'New encrypted message', body: 'Open 6529 Mobile to view' },
  added: { title: '6529', body: 'You were added to an encrypted chat' }
} satisfies Record<E2eeWakeReason, { title: string; body: string }>;

export interface E2eeWakeRequest {
  readonly profileIds: string[];
  readonly reason: E2eeWakeReason;
}

export interface E2eeWakeDevice {
  readonly device_id: string;
  readonly profile_id: string;
  readonly token: string;
  readonly is_multi_profile: number | string;
}

export interface E2eeWakeDeps {
  loadDevices(profileIds: string[]): Promise<E2eeWakeDevice[]>;
  loadHandles(profileIds: string[]): Promise<Map<string, string>>;
  loadPreferences(
    profileIds: string[]
  ): Promise<Map<string, ProfilePreferencesData>>;
  send(
    inputs: PushNotificationMessageInput[]
  ): Promise<PushNotificationSendResult[]>;
  deleteDevice(device: E2eeWakeDevice): Promise<void>;
}

/** Parses an SQS body of type `e2ee_wake`; null when it is not one. */
export function parseE2eeWakeMessage(body: unknown): E2eeWakeRequest | null {
  if (!body || typeof body !== 'object') return null;
  const {
    type,
    profile_ids: profileIds,
    reason
  } = body as Record<string, unknown>;
  if (type !== 'e2ee_wake') return null;
  if (reason !== 'message' && reason !== 'added') return null;
  if (!Array.isArray(profileIds)) return null;
  const ids = profileIds.filter(
    (id): id is string => typeof id === 'string' && !!id.trim()
  );
  return { profileIds: Array.from(new Set(ids)), reason };
}

/** The FCM input for one device. Nothing here depends on message content. */
export function buildE2eeWakeInput({
  token,
  profileId,
  handle,
  reason,
  showRecipient = false
}: {
  readonly token: string;
  readonly profileId: string;
  readonly handle?: string;
  readonly reason: E2eeWakeReason;
  readonly showRecipient?: boolean;
}): PushNotificationMessageInput {
  const { title, body } = E2EE_WAKE_COPY[reason];
  return {
    title:
      reason === 'message' && showRecipient && handle
        ? `${buildMultiProfileTitlePrefix(handle)} ${title}`
        : title,
    body:
      reason === 'message' && process.env.NODE_ENV === 'development'
        ? 'Open 6529 Staging to view'
        : body,
    token,
    notification_id: 0,
    omitBadge: true,
    extra_data: {
      redirect: 'e2ee',
      target_profile_id: profileId,
      target_profile_handle: handle ?? profileId,
      notification_id: 'e2ee'
    }
  };
}

/** Encrypted chats follow the "Direct messages" notification preference. */
export function isE2eeWakeEnabled(
  preferences: ProfilePreferencesData | undefined
): boolean {
  if (!preferences) return true;
  if (
    preferences.notification_level === ProfileNotificationLevel.ESSENTIAL_ONLY
  ) {
    return false;
  }
  return preferences.notifications.direct_messages;
}

function isUnregistered(result: PushNotificationSendResult): boolean {
  const code = result.response.error?.code;
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token'
  );
}

export const defaultE2eeWakeDeps: E2eeWakeDeps = {
  async loadDevices(profileIds) {
    if (!profileIds.length) return [];
    return dbSupplier().execute<E2eeWakeDevice>(
      `select device.device_id, device.profile_id, device.token,
              exists (
                select 1
                from ${PUSH_NOTIFICATION_DEVICES_TABLE} other
                where other.device_id = device.device_id
                  and cast(other.token as binary) = cast(device.token as binary)
                  and other.profile_id <> device.profile_id
              ) as is_multi_profile
       from ${PUSH_NOTIFICATION_DEVICES_TABLE} device
       where device.profile_id in (:profileIds)`,
      { profileIds }
    );
  },
  async loadHandles(profileIds) {
    if (!profileIds.length) return new Map();
    const rows = await dbSupplier().execute<{
      profile_id: string;
      handle: string | null;
      normalised_handle: string | null;
    }>(
      `select profile_id, handle, normalised_handle from ${IDENTITIES_TABLE}
       where profile_id in (:profileIds)`,
      { profileIds }
    );
    const handles = new Map<string, string>();
    for (const row of rows) {
      const handle = row.normalised_handle || row.handle;
      if (handle) handles.set(row.profile_id, handle);
    }
    return handles;
  },
  loadPreferences: (profileIds) => profilePreferencesDb.getMany(profileIds),
  send: (inputs) => sendMessages(inputs),
  async deleteDevice(device) {
    await dbSupplier().execute(
      `delete from ${PUSH_NOTIFICATION_DEVICES_TABLE}
       where device_id = :device_id and profile_id = :profile_id and token = :token`,
      { ...device }
    );
  }
};

/**
 * Sends wakes to every registered push device of the recipient profiles.
 * Wakes are hints: delivery failures are not retried (a retry could repeat
 * wakes that already arrived); unregistered tokens are removed.
 */
export async function sendE2eeWakes(
  requests: E2eeWakeRequest[],
  deps: E2eeWakeDeps = defaultE2eeWakeDeps
): Promise<void> {
  const reasonByProfile = new Map<string, E2eeWakeReason>();
  for (const request of requests) {
    for (const profileId of request.profileIds) {
      // "added" is the more specific notice when both arrive together.
      if (reasonByProfile.get(profileId) !== 'added') {
        reasonByProfile.set(profileId, request.reason);
      }
    }
  }
  const profileIds = Array.from(reasonByProfile.keys());
  if (!profileIds.length) return;
  const [devices, handles, preferences] = await Promise.all([
    deps.loadDevices(profileIds),
    deps.loadHandles(profileIds),
    deps.loadPreferences(profileIds)
  ]);
  const targets = devices.filter((device) =>
    isE2eeWakeEnabled(preferences.get(device.profile_id))
  );
  if (!targets.length) return;
  // Wakes are not retried: a send that fails part-way must not make SQS
  // redeliver the whole batch to devices that already got it. Only the loads
  // above may throw (and then nothing was sent).
  let results: Awaited<ReturnType<E2eeWakeDeps['send']>>;
  try {
    results = await deps.send(
      targets.map((device) =>
        buildE2eeWakeInput({
          token: device.token,
          profileId: device.profile_id,
          handle: handles.get(device.profile_id),
          reason: reasonByProfile.get(device.profile_id)!,
          showRecipient: Number(device.is_multi_profile) === 1
        })
      )
    );
  } catch (error) {
    logger.warn(
      `Encrypted-message wakes failed part-way: ${
        (error as Error)?.message ?? 'unknown'
      }`
    );
    return;
  }
  let delivered = 0;
  await Promise.all(
    results.map(async (result, index) => {
      if (result.response.success) {
        delivered++;
        return;
      }
      if (!isUnregistered(result)) return;
      try {
        await deps.deleteDevice(targets[index]);
      } catch {
        logger.warn('Failed to delete an unregistered push token');
      }
    })
  );
  logger.info(`Sent ${delivered} of ${targets.length} encrypted-message wakes`);
}
