import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  ProfileNotificationCategories,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';

type NotificationCategory = keyof ProfileNotificationCategories;

const CAUSE_CATEGORY: Record<IdentityNotificationCause, NotificationCategory> =
  {
    [IdentityNotificationCause.IDENTITY_SUBSCRIBED]: 'new_followers',
    [IdentityNotificationCause.IDENTITY_MENTIONED]: 'mentions_replies_quotes',
    [IdentityNotificationCause.IDENTITY_REP]: 'rep_and_nic',
    [IdentityNotificationCause.IDENTITY_NIC]: 'rep_and_nic',
    [IdentityNotificationCause.DROP_QUOTED]: 'mentions_replies_quotes',
    [IdentityNotificationCause.DROP_REPLIED]: 'mentions_replies_quotes',
    [IdentityNotificationCause.DROP_VOTED]: 'reactions_votes_boosts',
    [IdentityNotificationCause.DROP_POLL_VOTED]: 'reactions_votes_boosts',
    [IdentityNotificationCause.DROP_REACTED]: 'reactions_votes_boosts',
    [IdentityNotificationCause.DROP_BOOSTED]: 'reactions_votes_boosts',
    [IdentityNotificationCause.WAVE_CREATED]: 'direct_messages',
    [IdentityNotificationCause.ALL_DROPS]: 'direct_messages',
    [IdentityNotificationCause.PRIORITY_ALERT]: 'direct_messages',
    [IdentityNotificationCause.SUBSCRIPTION_COVERAGE]: 'subscription_coverage'
  };

export function isNotificationEnabled(
  cause: IdentityNotificationCause,
  preferences: ProfilePreferencesData
): boolean {
  if (
    preferences.notification_level === ProfileNotificationLevel.ESSENTIAL_ONLY
  ) {
    return false;
  }
  return preferences.notifications[CAUSE_CATEGORY[cause]];
}
