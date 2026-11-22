import { createHash } from 'node:crypto';

const SOURCE_KEY_DOMAIN = '6529.notify.v1';
const ID_SPREAD = 4096;
/** The last millisecond whose ids stay safe JavaScript integers (Sep 2039). */
export const MAX_VIEW_ID_CREATED_AT = Math.floor(
  (Number.MAX_SAFE_INTEGER - (ID_SPREAD - 1)) / ID_SPREAD
);

/**
 * A row's identity: which rule produced it (family), from which source
 * (ref: an event id, a transaction id, an entity id) and for whom. The same
 * inputs always give the same key, so a rebuild writes the same rows.
 */
export function notificationSourceKey(
  family: string,
  ref: string,
  recipientId: string
): string {
  return createHash('sha256')
    .update([SOURCE_KEY_DOMAIN, family, ref, recipientId].join('\u0000'))
    .digest('hex');
}

/**
 * The id clients page and mark read by: ordered by time, deterministic, and
 * a safe integer. It is above every identity_notifications id, so rows copied
 * at the switch can keep their old id and still sort before every new row.
 */
export function notificationViewId(
  createdAt: number,
  sourceKey: string
): number {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error(`Invalid notification time ${createdAt}`);
  }
  if (createdAt > MAX_VIEW_ID_CREATED_AT) {
    throw new Error('Notification time is past the id range');
  }
  if (!/^[0-9a-f]{64}$/.test(sourceKey)) {
    throw new Error('Invalid notification source key');
  }
  return createdAt * ID_SPREAD + Number.parseInt(sourceKey.slice(0, 3), 16);
}
