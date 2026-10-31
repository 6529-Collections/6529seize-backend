import {
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_PREFERENCES_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileDirectMessagePolicy,
  ProfileNotificationLevel,
  ProfilePreferencesData,
  ProfilePreferencesUpdate
} from '@/entities/IProfilePreferences';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type ProfilePreferencesRow = {
  profile_id: string;
  direct_message_policy: ProfileDirectMessagePolicy;
  direct_message_group_id?: string | null;
  direct_message_allow_people_i_follow?: boolean | number | string | null;
  notification_level: ProfileNotificationLevel;
  notify_direct_messages: boolean | number | string;
  notify_mentions_replies_quotes: boolean | number | string;
  notify_reactions_votes_boosts: boolean | number | string;
  notify_new_followers: boolean | number | string;
  notify_rep_and_nic: boolean | number | string;
  notify_subscription_coverage: boolean | number | string;
};

/**
 * Everything direct-message admission needs to know about one recipient,
 * relative to the profile that is starting the conversation (the creator).
 */
export interface DirectMessageRecipientPreference {
  readonly profile_id: string;
  readonly primary_address: string;
  readonly handle: string;
  readonly direct_message_policy: ProfileDirectMessagePolicy;
  readonly direct_message_group_id: string | null;
  readonly direct_message_allow_people_i_follow: boolean;
  /** The recipient follows the creator. */
  readonly follows_creator: boolean;
  /** The recipient has blocked the creator. Never disclosed to the creator. */
  readonly recipient_blocked_creator: boolean;
  /** The creator has blocked the recipient. */
  readonly creator_blocked_recipient: boolean;
}

type DirectMessageRecipientSelector =
  | { readonly addresses: string[] }
  | { readonly profileIds: string[] };

type DirectMessageRecipientRow = Omit<
  DirectMessageRecipientPreference,
  | 'direct_message_group_id'
  | 'direct_message_allow_people_i_follow'
  | 'follows_creator'
  | 'recipient_blocked_creator'
  | 'creator_blocked_recipient'
> & {
  direct_message_group_id?: string | null;
  direct_message_allow_people_i_follow?: boolean | number | string | null;
  follows_creator: boolean | number | string;
  recipient_blocked_creator?: boolean | number | string | null;
  creator_blocked_recipient?: boolean | number | string | null;
};

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toBooleanOr(
  value: boolean | number | string | null | undefined,
  fallback: boolean
): boolean {
  return value === null || value === undefined ? fallback : toBoolean(value);
}

function mapRow(row: ProfilePreferencesRow): ProfilePreferencesData {
  return {
    direct_message_policy: row.direct_message_policy,
    direct_message_group_id: row.direct_message_group_id ?? null,
    direct_message_allow_people_i_follow: toBooleanOr(
      row.direct_message_allow_people_i_follow,
      DEFAULT_PROFILE_PREFERENCES.direct_message_allow_people_i_follow
    ),
    notification_level: row.notification_level,
    notifications: {
      direct_messages: toBoolean(row.notify_direct_messages),
      mentions_replies_quotes: toBoolean(row.notify_mentions_replies_quotes),
      reactions_votes_boosts: toBoolean(row.notify_reactions_votes_boosts),
      new_followers: toBoolean(row.notify_new_followers),
      rep_and_nic: toBoolean(row.notify_rep_and_nic),
      subscription_coverage: toBoolean(row.notify_subscription_coverage)
    }
  };
}

export class ProfilePreferencesDb extends LazyDbAccessCompatibleService {
  async get(
    profileId: string,
    connection?: ConnectionWrapper<unknown>
  ): Promise<ProfilePreferencesData> {
    const row = await this.db.oneOrNull<ProfilePreferencesRow>(
      `select * from ${PROFILE_PREFERENCES_TABLE} where profile_id = :profileId`,
      { profileId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return row ? mapRow(row) : DEFAULT_PROFILE_PREFERENCES;
  }

  async getMany(
    profileIds: string[],
    connection?: ConnectionWrapper<unknown>
  ): Promise<Map<string, ProfilePreferencesData>> {
    if (!profileIds.length) return new Map();
    const rows = await this.db.execute<ProfilePreferencesRow>(
      `select * from ${PROFILE_PREFERENCES_TABLE} where profile_id in (:profileIds)`,
      { profileIds },
      connection ? { wrappedConnection: connection } : undefined
    );
    return new Map(rows.map((row) => [row.profile_id, mapRow(row)]));
  }

  async upsert(
    profileId: string,
    update: ProfilePreferencesUpdate
  ): Promise<ProfilePreferencesData> {
    const notifications = update.notifications ?? {};
    const assignments: string[] = [];
    if (update.direct_message_policy !== undefined) {
      assignments.push('direct_message_policy = :directMessagePolicy');
    }
    if (update.direct_message_group_id !== undefined) {
      assignments.push('direct_message_group_id = :directMessageGroupId');
    }
    if (update.direct_message_allow_people_i_follow !== undefined) {
      assignments.push(
        'direct_message_allow_people_i_follow = :directMessageAllowPeopleIFollow'
      );
    }
    if (update.notification_level !== undefined) {
      assignments.push('notification_level = :notificationLevel');
    }
    if (notifications.direct_messages !== undefined) {
      assignments.push('notify_direct_messages = :directMessages');
    }
    if (notifications.mentions_replies_quotes !== undefined) {
      assignments.push(
        'notify_mentions_replies_quotes = :mentionsRepliesQuotes'
      );
    }
    if (notifications.reactions_votes_boosts !== undefined) {
      assignments.push('notify_reactions_votes_boosts = :reactionsVotesBoosts');
    }
    if (notifications.new_followers !== undefined) {
      assignments.push('notify_new_followers = :newFollowers');
    }
    if (notifications.rep_and_nic !== undefined) {
      assignments.push('notify_rep_and_nic = :repAndNic');
    }
    if (notifications.subscription_coverage !== undefined) {
      assignments.push('notify_subscription_coverage = :subscriptionCoverage');
    }
    if (!assignments.length) {
      assignments.push('profile_id = values(profile_id)');
    }

    const params = {
      profileId,
      directMessagePolicy:
        update.direct_message_policy ??
        DEFAULT_PROFILE_PREFERENCES.direct_message_policy,
      directMessageGroupId:
        update.direct_message_group_id ??
        DEFAULT_PROFILE_PREFERENCES.direct_message_group_id,
      directMessageAllowPeopleIFollow:
        update.direct_message_allow_people_i_follow ??
        DEFAULT_PROFILE_PREFERENCES.direct_message_allow_people_i_follow,
      notificationLevel:
        update.notification_level ??
        DEFAULT_PROFILE_PREFERENCES.notification_level,
      directMessages:
        notifications.direct_messages ??
        DEFAULT_PROFILE_PREFERENCES.notifications.direct_messages,
      mentionsRepliesQuotes:
        notifications.mentions_replies_quotes ??
        DEFAULT_PROFILE_PREFERENCES.notifications.mentions_replies_quotes,
      reactionsVotesBoosts:
        notifications.reactions_votes_boosts ??
        DEFAULT_PROFILE_PREFERENCES.notifications.reactions_votes_boosts,
      newFollowers:
        notifications.new_followers ??
        DEFAULT_PROFILE_PREFERENCES.notifications.new_followers,
      repAndNic:
        notifications.rep_and_nic ??
        DEFAULT_PROFILE_PREFERENCES.notifications.rep_and_nic,
      subscriptionCoverage:
        notifications.subscription_coverage ??
        DEFAULT_PROFILE_PREFERENCES.notifications.subscription_coverage
    };

    return this.executeNativeQueriesInTransaction(async (connection) => {
      await this.db.execute(
        `select external_id from ${PROFILES_TABLE}
         where external_id = :profileId for update`,
        { profileId },
        { wrappedConnection: connection }
      );
      await this.db.execute(
        `insert into ${PROFILE_PREFERENCES_TABLE} (
          profile_id, direct_message_policy, direct_message_group_id,
          direct_message_allow_people_i_follow, notification_level,
          notify_direct_messages, notify_mentions_replies_quotes,
          notify_reactions_votes_boosts, notify_new_followers,
          notify_rep_and_nic, notify_subscription_coverage
        ) values (
          :profileId, :directMessagePolicy, :directMessageGroupId,
          :directMessageAllowPeopleIFollow, :notificationLevel,
          :directMessages, :mentionsRepliesQuotes,
          :reactionsVotesBoosts, :newFollowers,
          :repAndNic, :subscriptionCoverage
        ) on duplicate key update ${assignments.join(', ')}`,
        params,
        { wrappedConnection: connection }
      );
      return this.get(profileId, connection);
    });
  }

  async getDirectMessageRecipientsForAdmission(
    addresses: string[],
    creatorProfileId: string,
    connection: ConnectionWrapper<unknown>
  ): Promise<DirectMessageRecipientPreference[]> {
    if (!addresses.length) return [];
    return this.getDirectMessageRecipients(
      addresses,
      creatorProfileId,
      connection,
      true
    );
  }

  async getDirectMessageRecipients(
    addresses: string[],
    creatorProfileId: string,
    connection?: ConnectionWrapper<unknown>,
    lockForUpdate = false
  ): Promise<DirectMessageRecipientPreference[]> {
    if (!addresses.length) return [];
    return this.findDirectMessageRecipients(
      { addresses },
      creatorProfileId,
      connection,
      lockForUpdate
    );
  }

  /**
   * Admission facts for recipients identified by profile id (the shape an
   * E2EE group roster uses). Ids without an identity and profile are omitted.
   */
  async getDirectMessageRecipientsByProfileIds(
    profileIds: string[],
    creatorProfileId: string,
    connection?: ConnectionWrapper<unknown>,
    lockForUpdate = false
  ): Promise<DirectMessageRecipientPreference[]> {
    if (!profileIds.length) return [];
    return this.findDirectMessageRecipients(
      { profileIds },
      creatorProfileId,
      connection,
      lockForUpdate
    );
  }

  private async findDirectMessageRecipients(
    selector: DirectMessageRecipientSelector,
    creatorProfileId: string,
    connection: ConnectionWrapper<unknown> | undefined,
    lockForUpdate: boolean
  ): Promise<DirectMessageRecipientPreference[]> {
    const recipientFilter =
      'addresses' in selector
        ? 'i.primary_address in (:addresses)'
        : 'i.profile_id in (:profileIds)';
    const rows = await this.db.execute<DirectMessageRecipientRow>(
      `select i.profile_id, i.primary_address, i.handle,
        coalesce(p.direct_message_policy, :defaultPolicy) as direct_message_policy,
        p.direct_message_group_id as direct_message_group_id,
        p.direct_message_allow_people_i_follow as direct_message_allow_people_i_follow,
        exists(select 1 from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
          where s.subscriber_id = i.profile_id
            and s.target_id = :creatorProfileId
            and s.target_type = :targetType) as follows_creator,
        exists(select 1 from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} rb
          where rb.blocker_profile_id = i.profile_id
            and rb.blocked_profile_id = :creatorProfileId) as recipient_blocked_creator,
        exists(select 1 from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} cb
          where cb.blocker_profile_id = :creatorProfileId
            and cb.blocked_profile_id = i.profile_id) as creator_blocked_recipient
      from ${IDENTITIES_TABLE} i
      join ${PROFILES_TABLE} profile_lock
        on profile_lock.external_id = i.profile_id
      left join ${PROFILE_PREFERENCES_TABLE} p on p.profile_id = i.profile_id
      where ${recipientFilter} and i.profile_id is not null
      order by i.profile_id
      ${lockForUpdate ? 'for update' : ''}`,
      {
        ...selector,
        creatorProfileId,
        targetType: ActivityEventTargetType.IDENTITY,
        defaultPolicy: ProfileDirectMessagePolicy.EVERYONE
      },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.map((row) => ({
      ...row,
      direct_message_group_id: row.direct_message_group_id ?? null,
      direct_message_allow_people_i_follow: toBooleanOr(
        row.direct_message_allow_people_i_follow,
        DEFAULT_PROFILE_PREFERENCES.direct_message_allow_people_i_follow
      ),
      follows_creator: toBoolean(row.follows_creator),
      recipient_blocked_creator: toBooleanOr(
        row.recipient_blocked_creator,
        false
      ),
      creator_blocked_recipient: toBooleanOr(
        row.creator_blocked_recipient,
        false
      )
    }));
  }
}

export const profilePreferencesDb = new ProfilePreferencesDb(dbSupplier);
