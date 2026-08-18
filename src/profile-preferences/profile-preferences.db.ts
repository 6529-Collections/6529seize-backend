import {
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_PREFERENCES_TABLE
} from '@/constants';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileDirectMessagePolicy,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type ProfilePreferencesRow = {
  profile_id: string;
  direct_message_policy: ProfileDirectMessagePolicy;
  notification_level: ProfileNotificationLevel;
  notify_direct_messages: boolean | number | string;
  notify_mentions_replies_quotes: boolean | number | string;
  notify_reactions_votes_boosts: boolean | number | string;
  notify_new_followers: boolean | number | string;
  notify_rep_and_nic: boolean | number | string;
  notify_subscription_coverage: boolean | number | string;
};

export interface DirectMessageRecipientPreference {
  readonly profile_id: string;
  readonly primary_address: string;
  readonly handle: string;
  readonly direct_message_policy: ProfileDirectMessagePolicy;
  readonly follows_creator: boolean;
}

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function mapRow(row: ProfilePreferencesRow): ProfilePreferencesData {
  return {
    direct_message_policy: row.direct_message_policy,
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
    connection?: ConnectionWrapper<any>
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
    connection?: ConnectionWrapper<any>
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
    update: Partial<ProfilePreferencesData>
  ): Promise<ProfilePreferencesData> {
    const current = await this.get(profileId);
    const merged: ProfilePreferencesData = {
      ...current,
      ...update,
      notifications: { ...current.notifications, ...update.notifications }
    };
    await this.db.execute(
      `insert into ${PROFILE_PREFERENCES_TABLE} (
        profile_id, direct_message_policy, notification_level,
        notify_direct_messages, notify_mentions_replies_quotes,
        notify_reactions_votes_boosts, notify_new_followers,
        notify_rep_and_nic, notify_subscription_coverage
      ) values (
        :profileId, :directMessagePolicy, :notificationLevel,
        :directMessages, :mentionsRepliesQuotes,
        :reactionsVotesBoosts, :newFollowers,
        :repAndNic, :subscriptionCoverage
      ) on duplicate key update
        direct_message_policy = values(direct_message_policy),
        notification_level = values(notification_level),
        notify_direct_messages = values(notify_direct_messages),
        notify_mentions_replies_quotes = values(notify_mentions_replies_quotes),
        notify_reactions_votes_boosts = values(notify_reactions_votes_boosts),
        notify_new_followers = values(notify_new_followers),
        notify_rep_and_nic = values(notify_rep_and_nic),
        notify_subscription_coverage = values(notify_subscription_coverage)`,
      {
        profileId,
        directMessagePolicy: merged.direct_message_policy,
        notificationLevel: merged.notification_level,
        directMessages: merged.notifications.direct_messages,
        mentionsRepliesQuotes: merged.notifications.mentions_replies_quotes,
        reactionsVotesBoosts: merged.notifications.reactions_votes_boosts,
        newFollowers: merged.notifications.new_followers,
        repAndNic: merged.notifications.rep_and_nic,
        subscriptionCoverage: merged.notifications.subscription_coverage
      }
    );
    return merged;
  }

  async getDirectMessageRecipients(
    addresses: string[],
    creatorProfileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<DirectMessageRecipientPreference[]> {
    if (!addresses.length) return [];
    const rows = await this.db.execute<
      DirectMessageRecipientPreference & {
        follows_creator: boolean | number | string;
      }
    >(
      `select i.profile_id, i.primary_address, i.handle,
        coalesce(p.direct_message_policy, :defaultPolicy) as direct_message_policy,
        exists(select 1 from ${IDENTITY_SUBSCRIPTIONS_TABLE} s
          where s.subscriber_id = i.profile_id
            and s.target_id = :creatorProfileId
            and s.target_type = :targetType) as follows_creator
      from ${IDENTITIES_TABLE} i
      left join ${PROFILE_PREFERENCES_TABLE} p on p.profile_id = i.profile_id
      where i.primary_address in (:addresses) and i.profile_id is not null`,
      {
        addresses,
        creatorProfileId,
        targetType: ActivityEventTargetType.IDENTITY,
        defaultPolicy: ProfileDirectMessagePolicy.EVERYONE
      },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.map((row) => ({
      ...row,
      follows_creator: toBoolean(row.follows_creator)
    }));
  }
}

export const profilePreferencesDb = new ProfilePreferencesDb(dbSupplier);
