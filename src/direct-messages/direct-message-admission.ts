import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { CustomApiCompliantException } from '@/exceptions';

/**
 * Inbound direct-message admission: may `sender` start a NEW conversation with
 * `recipient`? Existing conversations never consult this decision.
 *
 * Order of evaluation (first match wins):
 * 1. The sender has blocked the recipient -> refused, and the sender is told
 *    about their own block.
 * 2. The recipient has blocked the sender -> refused with the generic
 *    "doesn't accept new messages" reason. A block is never disclosed.
 * 3. The recipient's `direct_message_policy`:
 *    - EVERYONE: admitted.
 *    - NOBODY: refused.
 *    - PEOPLE_I_FOLLOW: admitted only when the recipient follows the sender.
 *    - GROUP_MEMBERS: admitted when the sender is a member of the recipient's
 *      chosen group, or (when `allowPeopleIFollow` is on) when the recipient
 *      follows the sender. A missing or hidden group fails closed to
 *      PEOPLE_I_FOLLOW.
 *    - Any other stored value fails closed to "doesn't accept new messages".
 *
 * Step 1 runs before step 2 so the response for a sender who blocked the
 * recipient does not change with the recipient's own block.
 */

export enum DirectMessageRefusalReason {
  NOT_ACCEPTING = 'NOT_ACCEPTING',
  PEOPLE_I_FOLLOW_ONLY = 'PEOPLE_I_FOLLOW_ONLY',
  GROUP_MEMBERS_ONLY = 'GROUP_MEMBERS_ONLY',
  SENDER_BLOCKED_RECIPIENT = 'SENDER_BLOCKED_RECIPIENT'
}

/** Stable API error codes; clients render localized copy from these. */
export const DIRECT_MESSAGE_ADMISSION_ERROR_CODES: Readonly<
  Record<DirectMessageRefusalReason, string>
> = {
  [DirectMessageRefusalReason.NOT_ACCEPTING]: 'DM_RECIPIENT_NOT_ACCEPTING',
  [DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY]:
    'DM_RECIPIENT_PEOPLE_I_FOLLOW_ONLY',
  [DirectMessageRefusalReason.GROUP_MEMBERS_ONLY]:
    'DM_RECIPIENT_GROUP_MEMBERS_ONLY',
  [DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT]:
    'DM_SENDER_BLOCKED_RECIPIENT'
};

/** A group the recipient chose and made public, so it may be named. */
export interface DirectMessagePublicGroup {
  readonly id: string;
  readonly name: string;
}

/** The recipient's chosen group, as the admission decision sees it. */
export type DirectMessageAdmissionGroupState =
  /** The recipient's policy does not use a group. */
  | { readonly status: 'NOT_USED' }
  /** The chosen group is missing, hidden or unusable: fail closed. */
  | { readonly status: 'UNAVAILABLE' }
  | {
      readonly status: 'AVAILABLE';
      readonly senderIsMember: boolean;
      /** Set only when the group is public; private groups are never named. */
      readonly publicGroup: DirectMessagePublicGroup | null;
    };

export interface DirectMessageAdmissionFacts {
  readonly recipientProfileId: string;
  readonly recipientHandle: string | null;
  readonly policy: ProfileDirectMessagePolicy;
  readonly allowPeopleIFollow: boolean;
  readonly recipientFollowsSender: boolean;
  readonly recipientBlockedSender: boolean;
  readonly senderBlockedRecipient: boolean;
  readonly group: DirectMessageAdmissionGroupState;
}

export type DirectMessageAdmission =
  | {
      readonly allowed: true;
      readonly recipientProfileId: string;
    }
  | {
      readonly allowed: false;
      readonly recipientProfileId: string;
      readonly recipientHandle: string | null;
      readonly reason: DirectMessageRefusalReason;
      readonly publicGroup: DirectMessagePublicGroup | null;
    };

function admitted(facts: DirectMessageAdmissionFacts): DirectMessageAdmission {
  return { allowed: true, recipientProfileId: facts.recipientProfileId };
}

function refused(
  facts: DirectMessageAdmissionFacts,
  reason: DirectMessageRefusalReason,
  publicGroup: DirectMessagePublicGroup | null = null
): DirectMessageAdmission {
  return {
    allowed: false,
    recipientProfileId: facts.recipientProfileId,
    recipientHandle: facts.recipientHandle,
    reason,
    publicGroup
  };
}

function decideFollowedOnly(
  facts: DirectMessageAdmissionFacts
): DirectMessageAdmission {
  return facts.recipientFollowsSender
    ? admitted(facts)
    : refused(facts, DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY);
}

function decideGroupMembers(
  facts: DirectMessageAdmissionFacts
): DirectMessageAdmission {
  const group = facts.group;
  if (group.status !== 'AVAILABLE') {
    return decideFollowedOnly(facts);
  }
  if (group.senderIsMember) {
    return admitted(facts);
  }
  if (facts.allowPeopleIFollow && facts.recipientFollowsSender) {
    return admitted(facts);
  }
  return refused(
    facts,
    DirectMessageRefusalReason.GROUP_MEMBERS_ONLY,
    group.publicGroup
  );
}

/** Pure admission decision for one recipient. */
export function decideDirectMessageAdmission(
  senderProfileId: string,
  facts: DirectMessageAdmissionFacts
): DirectMessageAdmission {
  if (facts.recipientProfileId === senderProfileId) {
    return admitted(facts);
  }
  if (facts.senderBlockedRecipient) {
    return refused(facts, DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT);
  }
  if (facts.recipientBlockedSender) {
    return refused(facts, DirectMessageRefusalReason.NOT_ACCEPTING);
  }
  switch (facts.policy) {
    case ProfileDirectMessagePolicy.EVERYONE:
      return admitted(facts);
    case ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW:
      return decideFollowedOnly(facts);
    case ProfileDirectMessagePolicy.GROUP_MEMBERS:
      return decideGroupMembers(facts);
    case ProfileDirectMessagePolicy.NOBODY:
    default:
      return refused(facts, DirectMessageRefusalReason.NOT_ACCEPTING);
  }
}

function recipientLabel(handle: string | null): string {
  return handle ? `@${handle}` : 'this profile';
}

/** English fallback copy; clients localize from the error code instead. */
export function getDirectMessageRefusalMessage(
  refusal: Extract<DirectMessageAdmission, { allowed: false }>
): string {
  const recipient = recipientLabel(refusal.recipientHandle);
  const prefix = `You can't start a new direct message with ${recipient} because`;
  switch (refusal.reason) {
    case DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY:
      return `${prefix} they only accept messages from people they follow.`;
    case DirectMessageRefusalReason.GROUP_MEMBERS_ONLY:
      return refusal.publicGroup
        ? `${prefix} they only accept messages from members of the group "${refusal.publicGroup.name}".`
        : `${prefix} they only accept messages from members of a group they chose.`;
    case DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT:
      return `${prefix} you have blocked them. Unblock them to start a conversation.`;
    case DirectMessageRefusalReason.NOT_ACCEPTING:
    default:
      return `${prefix} they don't accept new direct messages.`;
  }
}

/**
 * The 403 API error for a refusal. Details carry only what the client needs
 * to render localized copy: the handle and, for a public group, its id and
 * name. A recipient's block is never part of the response.
 */
export function directMessageAdmissionError(
  refusal: Extract<DirectMessageAdmission, { allowed: false }>
): CustomApiCompliantException {
  return new CustomApiCompliantException(
    403,
    getDirectMessageRefusalMessage(refusal),
    DIRECT_MESSAGE_ADMISSION_ERROR_CODES[refusal.reason],
    {
      handle: refusal.recipientHandle,
      ...(refusal.publicGroup
        ? {
            group_id: refusal.publicGroup.id,
            group_name: refusal.publicGroup.name
          }
        : {})
    }
  );
}
