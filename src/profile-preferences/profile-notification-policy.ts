import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  ProfileNotificationCategories,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';

type NotificationCategory = keyof ProfileNotificationCategories;
type NotificationClassification = NotificationCategory | 'essential';

// Keep this exhaustive so every newly introduced notification cause must be
// deliberately classified as essential or assigned to an optional category.
const CAUSE_CLASSIFICATION: Record<
  IdentityNotificationCause,
  NotificationClassification
> = {
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
  // Fail open if a newer producer reaches an older deployment before its
  // classification is known. This avoids silently losing notification data.
  const classification = CAUSE_CLASSIFICATION[cause];
  if (!classification || classification === 'essential') {
    return true;
  }
  if (
    preferences.notification_level === ProfileNotificationLevel.ESSENTIAL_ONLY
  ) {
    return false;
  }
  return preferences.notifications[classification];
}
