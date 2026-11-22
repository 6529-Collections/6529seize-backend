import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  DerivedGroup,
  DerivedNotification
} from '@/notifications/view/derived-notification';
import type {
  DropReactionEvent,
  FollowChangedEvent
} from '@/notifications/view/notification-sources';

/** The reserved P33 reaction that carries a boost. */
export const BOOST_REACTION = 'boost';

const base = (
  recipientId: string,
  createdAt: number
): Omit<DerivedNotification, 'cause'> => ({
  identity_id: recipientId,
  created_at: createdAt,
  additional_identity_id: null,
  related_drop_id: null,
  related_drop_part_no: null,
  related_drop_2_id: null,
  related_drop_2_part_no: null,
  wave_id: null,
  visibility_group_id: null,
  additional_data: {}
});

/**
 * DROP_REACTED and DROP_BOOSTED (`reactions.service.ts`,
 * `drops.api.service.ts`): a reaction turned on notifies the drop's author,
 * unless it repeats the reactor's previous state or the author reacted.
 * Turning it off removes nothing, as today.
 */
export function deriveReaction(event: DropReactionEvent): DerivedGroup {
  const repeats =
    event.previous?.on === true && event.previous.reaction === event.reaction;
  if (!event.on || repeats || event.reactorId === event.dropAuthorId) {
    return { family: 'reaction', ref: event.eventId, rows: [] };
  }
  const boost = event.reaction === BOOST_REACTION;
  return {
    family: 'reaction',
    ref: event.eventId,
    rows: [
      {
        ...base(event.dropAuthorId, event.timeMs),
        cause: boost
          ? IdentityNotificationCause.DROP_BOOSTED
          : IdentityNotificationCause.DROP_REACTED,
        additional_identity_id: event.reactorId,
        related_drop_id: event.dropId,
        wave_id: event.waveId,
        visibility_group_id: event.visibilityGroupId,
        additional_data: boost ? {} : { reaction: event.reaction }
      }
    ]
  };
}

/**
 * IDENTITY_SUBSCRIBED (`identities.service.ts`): a follow notifies the
 * target each time the subscriber goes from not following to following.
 * The follows imported when follows move to the records notify nobody.
 */
export function deriveFollow(event: FollowChangedEvent): DerivedGroup {
  if (event.imported || !event.following || event.wasFollowing) {
    return { family: 'follow', ref: event.eventId, rows: [] };
  }
  return {
    family: 'follow',
    ref: event.eventId,
    rows: [
      {
        ...base(event.targetId, event.timeMs),
        cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
        additional_identity_id: event.subscriberId
      }
    ]
  };
}

/** A drop's reply target, as the drop index resolved it. */
export interface ReplyFacts {
  readonly dropId: string;
  readonly partNo: number;
  readonly authorId: string;
}

/** One quote in a drop: the part that quotes, and what it quotes. */
export interface QuoteFacts {
  readonly quotePartNo: number;
  readonly quotedDropId: string;
  readonly quotedPartNo: number;
  readonly quotedAuthorId: string;
}

/** One visible version of a drop (the root POST or an EDIT). */
export interface DropVersionFacts {
  readonly eventId: string;
  /** P33 3.6's effective time. */
  readonly timeMs: number;
  readonly reply: ReplyFacts | null;
  readonly quotes: readonly QuoteFacts[];
  /** Directly mentioned profiles, resolved. */
  readonly mentionedIds: readonly string[];
}

export interface WaveFollowerFacts {
  readonly identityId: string;
  /** The follower asked for every drop. */
  readonly allDrops: boolean;
  /** The follower opted in to the wave's group mentions (@all). */
  readonly groupOptIn: boolean;
}

/**
 * Everything the drop-creation rule needs, resolved by the drop index and
 * the lookups as of the root's anchor. `versions` are the visible ones,
 * root first, in P33 3.5's version order.
 */
export interface DropCreationFacts {
  readonly rootEventId: string;
  readonly dropId: string;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly authorId: string;
  /** Tombstoned by its author: every row of the drop goes. */
  readonly deleted: boolean;
  readonly versions: readonly DropVersionFacts[];
  /** Recipients of the root's @contributors, @admins and @devs mentions. */
  readonly permissionGroupMentionIds: readonly string[];
  /** The root mentions @all and its author may use it. */
  readonly mentionsAll: boolean;
  /** Wave followers for new drops, without the author and wave muters. */
  readonly followers: readonly WaveFollowerFacts[];
  /** Who of the candidates can read the wave and its parent. */
  readonly readers: ReadonlySet<string>;
  /** Who of the candidates muted the wave. */
  readonly mutedWave: ReadonlySet<string>;
  /** Competition entry content, or a reply in a collapsed-reply wave. */
  readonly suppressFollowers: boolean;
}

type DropRow = Omit<DerivedNotification, 'created_at'>;

/** Today's precedence for one version (`user.notifier.ts`): reply > quote > mention > all drops. */
function versionRows(
  facts: DropCreationFacts,
  version: DropVersionFacts
): Map<string, DropRow> {
  const common = {
    wave_id: facts.waveId,
    visibility_group_id: facts.visibilityGroupId,
    additional_data: {}
  };
  const rows = new Map<string, DropRow>();
  const add = (recipientId: string, row: Omit<DropRow, 'identity_id'>) => {
    if (recipientId === facts.authorId || rows.has(recipientId)) return;
    rows.set(recipientId, { identity_id: recipientId, ...row });
  };
  if (version.reply) {
    add(version.reply.authorId, {
      ...common,
      cause: IdentityNotificationCause.DROP_REPLIED,
      additional_identity_id: facts.authorId,
      related_drop_id: facts.dropId,
      related_drop_part_no: null,
      related_drop_2_id: version.reply.dropId,
      related_drop_2_part_no: version.reply.partNo
    });
  }
  for (const quote of version.quotes) {
    add(quote.quotedAuthorId, {
      ...common,
      cause: IdentityNotificationCause.DROP_QUOTED,
      additional_identity_id: facts.authorId,
      related_drop_id: facts.dropId,
      related_drop_part_no: quote.quotePartNo,
      related_drop_2_id: quote.quotedDropId,
      related_drop_2_part_no: quote.quotedPartNo
    });
  }
  const mentioned = mentionedRecipients(facts, version);
  const plain = {
    ...common,
    additional_identity_id: facts.authorId,
    related_drop_id: facts.dropId,
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null
  };
  for (const id of mentioned) {
    add(id, { ...plain, cause: IdentityNotificationCause.IDENTITY_MENTIONED });
  }
  if (!facts.suppressFollowers) {
    const mentionedSet = new Set(mentioned);
    for (const follower of facts.followers) {
      if (
        follower.allDrops &&
        facts.readers.has(follower.identityId) &&
        !mentionedSet.has(follower.identityId)
      ) {
        add(follower.identityId, {
          ...plain,
          cause: IdentityNotificationCause.ALL_DROPS
        });
      }
    }
  }
  return rows;
}

/** Today's mention set (`create-or-update-drop.use-case.ts`, notifyWaveDropRecipients). */
function mentionedRecipients(
  facts: DropCreationFacts,
  version: DropVersionFacts
): string[] {
  const candidates = Array.from(
    new Set([...version.mentionedIds, ...facts.permissionGroupMentionIds])
  );
  const direct = candidates.filter(
    (id) =>
      facts.readers.has(id) && id !== facts.authorId && !facts.mutedWave.has(id)
  );
  const viaAll = facts.mentionsAll
    ? facts.followers
        .filter(
          (follower) =>
            follower.groupOptIn && facts.readers.has(follower.identityId)
        )
        .map((follower) => follower.identityId)
    : [];
  return Array.from(new Set([...direct, ...viaAll]));
}

/**
 * DROP_REPLIED, DROP_QUOTED, IDENTITY_MENTIONED and ALL_DROPS
 * (`create-or-update-drop.use-case.ts` via `user.notifier.ts`). One row per
 * recipient per drop. The latest visible version decides who and why;
 * group mentions come from the root only, as today. A row shows at the time
 * of the first version that named its recipient, so an edit never makes a
 * notification new again. A deleted drop has no rows.
 */
export function deriveDropCreation(facts: DropCreationFacts): DerivedGroup {
  const latest = facts.versions.at(-1);
  if (facts.deleted || !latest) {
    return { family: 'drop', ref: facts.rootEventId, rows: [] };
  }
  const firstSeen = new Map<string, number>();
  for (const version of facts.versions) {
    for (const recipientId of Array.from(versionRows(facts, version).keys())) {
      if (!firstSeen.has(recipientId))
        firstSeen.set(recipientId, version.timeMs);
    }
  }
  const rows = Array.from(versionRows(facts, latest).values())
    .map((row) => ({
      ...row,
      created_at: firstSeen.get(row.identity_id) ?? latest.timeMs
    }))
    .sort((a, b) => a.identity_id.localeCompare(b.identity_id));
  return { family: 'drop', ref: facts.rootEventId, rows };
}

/** A priority alert drop, as the drop index resolved it. */
export interface PriorityAlertFacts {
  readonly rootEventId: string;
  readonly dropId: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly timeMs: number;
  readonly deleted: boolean;
  /** Members of any of the alert wave's groups, as of the drop's anchor. */
  readonly memberIds: readonly string[];
}

/**
 * PRIORITY_ALERT (`priority-alerts.context.ts`): an alert drop in the
 * configured wave notifies the members of the wave's groups, not its author.
 */
export function derivePriorityAlert(facts: PriorityAlertFacts): DerivedGroup {
  if (facts.deleted) {
    return { family: 'priority-alert', ref: facts.rootEventId, rows: [] };
  }
  return {
    family: 'priority-alert',
    ref: facts.rootEventId,
    rows: Array.from(new Set(facts.memberIds))
      .filter((id) => id !== facts.authorId)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        ...base(id, facts.timeMs),
        cause: IdentityNotificationCause.PRIORITY_ALERT,
        additional_identity_id: facts.authorId,
        related_drop_id: facts.dropId,
        wave_id: facts.waveId
      }))
  };
}
