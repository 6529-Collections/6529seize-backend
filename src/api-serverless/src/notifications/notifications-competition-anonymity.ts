import { anonymousCompetitionAuthor } from '@/competitions/competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { UserNotification } from '@/notifications/user-notification.types';

/** Derive attribution from durable notification IDs, including deleted drops. */
export function anonymousNotificationProfiles<T extends { id: string }>(
  notification: UserNotification,
  profiles: Record<string, T>,
  hiddenDropIds: ReadonlySet<string>
): Record<string, T> {
  let actorId: string;
  let dropId: string;
  switch (notification.cause) {
    case IdentityNotificationCause.IDENTITY_MENTIONED:
      actorId = notification.data.mentioner_identity_id;
      dropId = notification.data.drop_id;
      break;
    case IdentityNotificationCause.DROP_QUOTED:
      actorId = notification.data.quote_drop_author_id;
      dropId = notification.data.quote_drop_id;
      break;
    case IdentityNotificationCause.DROP_REPLIED:
      actorId = notification.data.reply_drop_author_id;
      dropId = notification.data.reply_drop_id;
      break;
    case IdentityNotificationCause.ALL_DROPS:
    case IdentityNotificationCause.PRIORITY_ALERT:
      actorId = notification.data.additional_identity_id;
      dropId = notification.data.drop_id;
      break;
    default:
      return profiles;
  }
  if (!hiddenDropIds.has(dropId) || !profiles[actorId]) return profiles;
  return {
    ...profiles,
    [actorId]: anonymousCompetitionAuthor(profiles[actorId], dropId)
  };
}
