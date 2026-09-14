export interface DeliveryTarget {
  messageId: string;
  destinationKey: string;
}
export interface DeliveryResult {
  messageId: string;
  operation: 'POST' | 'EDIT';
  destinationKey?: string;
}
interface DigestSnapshot {
  version: 1;
  groupKey: string;
  count: number;
}
export type EditDigestPlan = DigestSnapshot & {
  mode: 'EDIT';
  target: DeliveryTarget;
};
export type PostDigestPlan = DigestSnapshot & { mode: 'POST' } & (
    | { reason: 'NO_ACK' }
    | { reason: 'TARGET_MISSING'; destinationKey: string }
  );
export type DigestPlan = EditDigestPlan | PostDigestPlan;

export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}
export function isDestinationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function parseDeliveryTarget(value: unknown): DeliveryTarget {
  const v = value as Partial<DeliveryTarget> | null;
  if (!v || !isMessageId(v.messageId) || !isDestinationKey(v.destinationKey))
    throw new Error('INVALID_DELIVERY_TARGET');
  return { messageId: v.messageId, destinationKey: v.destinationKey };
}
export function parseDigestPlan(value: unknown, groupKey: string): DigestPlan {
  const v = value as {
    version?: unknown;
    groupKey?: unknown;
    count?: unknown;
    mode?: unknown;
    target?: unknown;
    reason?: unknown;
    destinationKey?: unknown;
  } | null;
  if (
    !v ||
    v.version !== 1 ||
    v.groupKey !== groupKey ||
    typeof v.count !== 'number' ||
    !Number.isSafeInteger(v.count) ||
    v.count < 2
  )
    throw new Error('INVALID_DIGEST_PLAN');
  const snapshot: DigestSnapshot = {
    version: 1,
    groupKey,
    count: v.count
  };
  if (v.mode === 'EDIT')
    return { ...snapshot, mode: 'EDIT', target: parseDeliveryTarget(v.target) };
  if (v.mode === 'POST' && v.reason === 'NO_ACK')
    return { ...snapshot, mode: 'POST', reason: 'NO_ACK' };
  if (
    v.mode === 'POST' &&
    v.reason === 'TARGET_MISSING' &&
    isDestinationKey(v.destinationKey)
  )
    return {
      ...snapshot,
      mode: 'POST',
      reason: 'TARGET_MISSING',
      destinationKey: v.destinationKey
    };
  throw new Error('INVALID_DIGEST_PLAN');
}
