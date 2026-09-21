import { createHash } from 'node:crypto';
import { getRedisClient } from '@/redis';
import type { BadgeDevice } from '@/pushNotificationsHandler/device-badge';

const RECEIPT_SECONDS = 8 * 86400;
const QUARANTINE_SECONDS = 86400;

function redis() {
  const client = getRedisClient();
  if (!client) throw new Error('Push delivery state requires Redis');
  return client;
}

function key(kind: string, parts: readonly (string | number)[]): string {
  const scope = process.env.FIREBASE_PROJECT_ID ?? '';
  return `push-${kind}:v1:${createHash('sha256')
    .update(JSON.stringify([scope, ...parts]))
    .digest('hex')}`;
}

function quarantineKey(device: BadgeDevice): string {
  return key('quarantine', [device.device_id, device.token]);
}

export function isSenderMismatch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'messaging/mismatched-credential'
  );
}

/** Keep registrations intact; a rotated token/project immediately uses another key. */
export async function quarantinePushTarget(device: BadgeDevice): Promise<void> {
  await redis().set(quarantineKey(device), '1', { EX: QUARANTINE_SECONDS });
}

export async function isPushTargetQuarantined(
  device: BadgeDevice
): Promise<boolean> {
  return (await redis().get(quarantineKey(device))) !== null;
}

function receiptKey(deviceId: string, notificationId: number): string {
  // Token rotation must not replay an already accepted notification on the same device.
  return key('delivered', [deviceId, notificationId]);
}

/** Called under the device lock; failures fail closed before another provider send. */
export async function deliveredPushIds(
  deviceId: string,
  ids: number[]
): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const values = await redis().mGet(ids.map((id) => receiptKey(deviceId, id)));
  return new Set(ids.filter((_id, index) => values[index] === '1'));
}

/** Record provider-accepted targets before returning any partial batch failure. */
export async function recordDeliveredPush(
  deviceId: string,
  notificationId: number
): Promise<void> {
  await redis().set(receiptKey(deviceId, notificationId), '1', {
    EX: RECEIPT_SECONDS
  });
}
