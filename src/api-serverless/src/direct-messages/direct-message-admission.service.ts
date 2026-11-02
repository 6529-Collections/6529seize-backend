import { collections } from '@/collections';
import {
  decideDirectMessageAdmission,
  DirectMessageAdmission,
  directMessageAdmissionError,
  DirectMessageAdmissionGroupState,
  DirectMessageRefusalReason
} from '@/direct-messages/direct-message-admission';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import type { UserGroupEntity } from '@/entities/IUserGroup';
import type {
  DirectMessageRecipientPreference,
  ProfilePreferencesDb
} from '@/profile-preferences/profile-preferences.db';
import type { RequestContext } from '@/request.context';
import type { Timer } from '@/time';

/** How long a sender's membership of a recipient's group is reused. */
export const DIRECT_MESSAGE_GROUP_MEMBERSHIP_CACHE_TTL_MS = 30_000;
const MEMBERSHIP_CACHE_MAX_ENTRIES = 5_000;

/** Group lookups admission needs; `UserGroupsService` implements both. */
export interface DirectMessageGroupDirectory {
  /** Visible groups only; hidden or deleted groups are omitted. */
  getByIds(ids: string[], ctx: RequestContext): Promise<UserGroupEntity[]>;
  /** Which of the given groups the profile belongs to right now. */
  getGroupsUserIsEligibleForByIds(
    profileId: string | null,
    groupIds: readonly string[],
    timer?: Timer
  ): Promise<string[]>;
}

export interface DirectMessageAdmissionDeps {
  readonly preferences: Pick<
    ProfilePreferencesDb,
    'getDirectMessageRecipientsByProfileIds'
  >;
  readonly groups: DirectMessageGroupDirectory;
  /** Display names after content moderation, keyed by group id. */
  readonly groupNames: (
    groups: UserGroupEntity[],
    ctx: RequestContext
  ) => Promise<Record<string, string>>;
  readonly now?: () => number;
}

export interface DirectMessageAdmissionContext {
  /** Run reads on this connection (for example inside a create transaction). */
  readonly connection?: RequestContext['connection'];
  /** Lock recipient profile rows `for update` (requires `connection`). */
  readonly lockForUpdate?: boolean;
  readonly timer?: Timer;
}

type DirectMessageRefusal = Extract<DirectMessageAdmission, { allowed: false }>;

function isGroupUsable(group: UserGroupEntity | undefined): boolean {
  return !!group && !group.is_direct_message;
}

/**
 * The single place that decides whether a profile may start a NEW direct
 * message with other profiles. Every conversation-creation path calls it:
 *
 * - Legacy DMs: `UserGroupsService.findOrCreateDirectMessageGroup` calls
 *   {@link assertRecipientsAdmitted} with recipient rows it has already locked
 *   inside the group-creation transaction.
 * - Encrypted (E2EE) DMs and groups: call {@link canStartDirectMessage},
 *   {@link evaluate} or {@link assertCanStartDirectMessage} with profile ids for
 *   every profile that is new to the roster, passing the roster transaction's
 *   connection with `lockForUpdate: true`. Use the shared instance exported from
 *   `direct-message-admission.instance.ts`.
 *
 * Existing conversations must not call this: admission only gates the start
 * of a conversation. Group membership is evaluated with the platform's group
 * eligibility rules at call time (TDH and REP change daily). Calls that pass a
 * `connection` (conversation creation) always evaluate it fresh; other calls
 * may reuse a result for {@link DIRECT_MESSAGE_GROUP_MEMBERSHIP_CACHE_TTL_MS}
 * per sender and group.
 */
export class DirectMessageAdmissionService {
  private readonly membershipCache = new Map<
    string,
    { readonly member: boolean; readonly expiresAt: number }
  >();

  constructor(private readonly deps: DirectMessageAdmissionDeps) {}

  /** May `senderProfileId` start a new conversation with one recipient? */
  async canStartDirectMessage(
    senderProfileId: string,
    recipientProfileId: string,
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<DirectMessageAdmission> {
    const decisions = await this.evaluate(
      senderProfileId,
      [recipientProfileId],
      ctx
    );
    return decisions.get(recipientProfileId)!;
  }

  /**
   * Admission for many recipients at once, keyed by recipient profile id. A
   * profile id without an identity and profile row is refused (fail closed).
   */
  async evaluate(
    senderProfileId: string,
    recipientProfileIds: readonly string[],
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<Map<string, DirectMessageAdmission>> {
    const ids = collections.distinct([...recipientProfileIds]);
    if (!ids.length) return new Map();
    const recipients =
      await this.deps.preferences.getDirectMessageRecipientsByProfileIds(
        ids,
        senderProfileId,
        ctx.connection,
        ctx.lockForUpdate ?? false
      );
    const decisions = await this.evaluateRecipients(
      senderProfileId,
      recipients,
      ctx
    );
    const byId = new Map(
      decisions.map((decision) => [decision.recipientProfileId, decision])
    );
    return new Map(
      ids.map((id) => [
        id,
        byId.get(id) ?? {
          allowed: false,
          recipientProfileId: id,
          recipientHandle: null,
          reason: DirectMessageRefusalReason.NOT_ACCEPTING,
          publicGroup: null
        }
      ])
    );
  }

  /** Throws the 403 for the first refused recipient, in input order. */
  async assertCanStartDirectMessage(
    senderProfileId: string,
    recipientProfileIds: readonly string[],
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<void> {
    const decisions = await this.evaluate(
      senderProfileId,
      recipientProfileIds,
      ctx
    );
    this.throwFirstRefusal(
      collections
        .distinct([...recipientProfileIds])
        .map((id) => decisions.get(id)!)
    );
  }

  /**
   * Same as {@link assertCanStartDirectMessage} for recipient rows the caller
   * has already loaded (and usually locked) in its own transaction.
   */
  async assertRecipientsAdmitted(
    senderProfileId: string,
    recipients: readonly DirectMessageRecipientPreference[],
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<void> {
    this.throwFirstRefusal(
      await this.evaluateRecipients(senderProfileId, recipients, ctx)
    );
  }

  /** Decisions for already-loaded recipient rows, in the same order. */
  async evaluateRecipients(
    senderProfileId: string,
    recipients: readonly DirectMessageRecipientPreference[],
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<DirectMessageAdmission[]> {
    const groupStates = await this.resolveGroupStates(
      senderProfileId,
      recipients,
      ctx
    );
    return recipients.map((recipient) =>
      decideDirectMessageAdmission(senderProfileId, {
        recipientProfileId: recipient.profile_id,
        recipientHandle: recipient.handle ?? null,
        policy: recipient.direct_message_policy,
        allowPeopleIFollow: recipient.direct_message_allow_people_i_follow,
        recipientFollowsSender: recipient.follows_creator,
        recipientBlockedSender: recipient.recipient_blocked_creator,
        senderBlockedRecipient: recipient.creator_blocked_recipient,
        group: groupStates.get(recipient.profile_id) ?? { status: 'NOT_USED' }
      })
    );
  }

  /**
   * True when `groupId` can currently back the GROUP_MEMBERS policy. A false
   * result means admission falls back to people the recipient follows.
   */
  async isGroupUsable(
    groupId: string | null,
    ctx: DirectMessageAdmissionContext = {}
  ): Promise<boolean> {
    if (!groupId) return false;
    const [group] = await this.deps.groups.getByIds(
      [groupId],
      this.requestContext(ctx)
    );
    return isGroupUsable(group);
  }

  private throwFirstRefusal(decisions: readonly DirectMessageAdmission[]) {
    const refusal = decisions.find(
      (decision): decision is DirectMessageRefusal => !decision.allowed
    );
    if (refusal) {
      throw directMessageAdmissionError(refusal);
    }
  }

  private requestContext(ctx: DirectMessageAdmissionContext): RequestContext {
    return {
      ...(ctx.connection ? { connection: ctx.connection } : {}),
      ...(ctx.timer ? { timer: ctx.timer } : {})
    };
  }

  /** Only recipients whose decision can depend on group membership. */
  private needsGroup(recipient: DirectMessageRecipientPreference): boolean {
    return (
      recipient.direct_message_policy ===
        ProfileDirectMessagePolicy.GROUP_MEMBERS &&
      !recipient.recipient_blocked_creator &&
      !recipient.creator_blocked_recipient
    );
  }

  private async resolveGroupStates(
    senderProfileId: string,
    recipients: readonly DirectMessageRecipientPreference[],
    ctx: DirectMessageAdmissionContext
  ): Promise<Map<string, DirectMessageAdmissionGroupState>> {
    const states = new Map<string, DirectMessageAdmissionGroupState>();
    const groupRecipients = recipients.filter(
      (recipient) =>
        this.needsGroup(recipient) && recipient.profile_id !== senderProfileId
    );
    if (!groupRecipients.length) return states;
    const requestContext = this.requestContext(ctx);
    const groupIds = collections.distinct(
      groupRecipients
        .map((recipient) => recipient.direct_message_group_id)
        .filter((id): id is string => !!id)
    );
    const usableGroups = new Map(
      (groupIds.length
        ? await this.deps.groups.getByIds(groupIds, requestContext)
        : []
      )
        .filter((group) => isGroupUsable(group))
        .map((group) => [group.id, group])
    );
    const memberOf = await this.getMemberships(
      senderProfileId,
      Array.from(usableGroups.keys()),
      ctx
    );
    const publicNames = await this.getPublicGroupNames(
      Array.from(usableGroups.values()).filter(
        (group) => !group.is_private && !memberOf.has(group.id)
      ),
      requestContext
    );
    for (const recipient of groupRecipients) {
      const group = recipient.direct_message_group_id
        ? usableGroups.get(recipient.direct_message_group_id)
        : undefined;
      if (!group) {
        states.set(recipient.profile_id, { status: 'UNAVAILABLE' });
        continue;
      }
      const publicName = publicNames[group.id];
      states.set(recipient.profile_id, {
        status: 'AVAILABLE',
        senderIsMember: memberOf.has(group.id),
        publicGroup:
          publicName === undefined ? null : { id: group.id, name: publicName }
      });
    }
    return states;
  }

  private async getPublicGroupNames(
    groups: UserGroupEntity[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    if (!groups.length) return {};
    return this.deps.groupNames(groups, ctx);
  }

  /**
   * The sender's memberships among `groupIds`. A transactional evaluation
   * (one that passes a connection, such as conversation creation) always
   * evaluates eligibility fresh; only non-transactional checks, such as an
   * eligibility probe before creating a conversation, reuse recent results.
   */
  private async getMemberships(
    senderProfileId: string,
    groupIds: string[],
    ctx: DirectMessageAdmissionContext
  ): Promise<Set<string>> {
    const now = this.now();
    const useCache = !ctx.connection;
    const memberOf = new Set<string>();
    const toEvaluate: string[] = [];
    for (const groupId of groupIds) {
      const cached = useCache
        ? this.membershipCache.get(this.membershipKey(senderProfileId, groupId))
        : undefined;
      if (cached && cached.expiresAt > now) {
        if (cached.member) memberOf.add(groupId);
      } else {
        toEvaluate.push(groupId);
      }
    }
    if (!toEvaluate.length) return memberOf;
    const eligible = new Set(
      await this.deps.groups.getGroupsUserIsEligibleForByIds(
        senderProfileId,
        toEvaluate,
        ctx.timer
      )
    );
    const expiresAt = now + DIRECT_MESSAGE_GROUP_MEMBERSHIP_CACHE_TTL_MS;
    for (const groupId of toEvaluate) {
      const member = eligible.has(groupId);
      this.rememberMembership(
        this.membershipKey(senderProfileId, groupId),
        member,
        expiresAt
      );
      if (member) memberOf.add(groupId);
    }
    return memberOf;
  }

  /** Insertion-ordered map as a bounded FIFO: evict the oldest entry. */
  private rememberMembership(key: string, member: boolean, expiresAt: number) {
    this.membershipCache.delete(key);
    if (this.membershipCache.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
      const oldest = this.membershipCache.keys().next();
      if (!oldest.done) this.membershipCache.delete(oldest.value);
    }
    this.membershipCache.set(key, { member, expiresAt });
  }

  private membershipKey(senderProfileId: string, groupId: string): string {
    return `${senderProfileId}\u0000${groupId}`;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
