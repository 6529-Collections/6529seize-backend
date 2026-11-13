import { createHash } from 'node:crypto';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';

/** Notification fields that identify the conversation or item a push is about. */
export interface PushNotificationGroupingSource {
  readonly cause: IdentityNotificationCause;
  readonly identity_id: string;
  readonly additional_identity_id: string | null;
  readonly related_drop_id: string | null;
  readonly wave_id: string | null;
  readonly additional_data: unknown;
}

export interface PushNotificationGrouping {
  /** APNs `thread-id`: groups notifications in Notification Center, never hides one. */
  threadId?: string;
  /** APNs `apns-collapse-id`: a newer push replaces the older one on the device. */
  collapseId?: string;
}

/**
 * Each superseding notification type names the actor whose latest state
 * replaces the previous push about the same item. A later vote, reaction,
 * boost, rating or follow from the same profile restates the current state,
 * so the older push carries nothing the recipient still needs. Mentions,
 * replies, quotes, poll votes, wave drops, alerts and competition updates are
 * distinct events and are never collapsed.
 */
const ACTOR_ITEM_COLLAPSE_KINDS: Partial<
  Record<IdentityNotificationCause, string>
> = {
  [IdentityNotificationCause.DROP_VOTED]: 'vote',
  [IdentityNotificationCause.DROP_REACTED]: 'reaction',
  [IdentityNotificationCause.DROP_BOOSTED]: 'boost'
};

const PROFILE_THREADS: Partial<Record<IdentityNotificationCause, string>> = {
  [IdentityNotificationCause.IDENTITY_SUBSCRIBED]: 'followers',
  [IdentityNotificationCause.IDENTITY_REP]: 'ratings',
  [IdentityNotificationCause.IDENTITY_NIC]: 'ratings',
  [IdentityNotificationCause.SUBSCRIPTION_COVERAGE]: 'subscriptions'
};

/** APNs rejects collapse identifiers over 64 bytes; digests keep keys bounded. */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

function digest(parts: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseAdditionalData(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function getThreadId(source: PushNotificationGroupingSource): string {
  const waveId = nonEmpty(source.wave_id);
  if (waveId) {
    return `wave:${digest(['wave', source.identity_id, waveId])}`;
  }
  const profileThread = PROFILE_THREADS[source.cause] ?? source.cause;
  return `profile:${digest(['profile', source.identity_id, profileThread])}`;
}

function getCollapseId(
  source: PushNotificationGroupingSource
): string | undefined {
  const actorId = nonEmpty(source.additional_identity_id);
  const itemKind = ACTOR_ITEM_COLLAPSE_KINDS[source.cause];
  if (itemKind) {
    const dropId = nonEmpty(source.related_drop_id);
    if (!actorId || !dropId) return undefined;
    return `${itemKind}:${digest([itemKind, source.identity_id, dropId, actorId])}`;
  }
  switch (source.cause) {
    case IdentityNotificationCause.IDENTITY_REP: {
      const category = nonEmpty(
        parseAdditionalData(source.additional_data).category
      );
      if (!actorId || !category) return undefined;
      return `rep:${digest(['rep', source.identity_id, actorId, category])}`;
    }
    case IdentityNotificationCause.IDENTITY_NIC:
      if (!actorId) return undefined;
      return `nic:${digest(['nic', source.identity_id, actorId])}`;
    case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      if (!actorId) return undefined;
      return `follow:${digest(['follow', source.identity_id, actorId])}`;
    case IdentityNotificationCause.SUBSCRIPTION_COVERAGE:
      return `subscription-coverage:${digest([
        'subscription-coverage',
        source.identity_id
      ])}`;
    default:
      return undefined;
  }
}

/**
 * Group pushes per recipient profile and wave (or per profile topic), and let
 * only superseding updates replace an earlier push. Every key includes the
 * recipient profile so profiles sharing a device never group or collapse
 * together. Routing data and the Android tag are not affected.
 */
export function getPushNotificationGrouping(
  source: PushNotificationGroupingSource
): PushNotificationGrouping {
  const threadId = getThreadId(source);
  const collapseId = getCollapseId(source);
  return collapseId ? { threadId, collapseId } : { threadId };
}
