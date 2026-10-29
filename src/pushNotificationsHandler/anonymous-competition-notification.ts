import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import {
  anonymousCompetitionAuthor,
  competitionAnonymityService
} from '@/competitions/competition-anonymity';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '@/entities/IIdentityNotification';

const DROP_AUTHOR_CAUSES: readonly IdentityNotificationCause[] = [
  IdentityNotificationCause.IDENTITY_MENTIONED,
  IdentityNotificationCause.DROP_QUOTED,
  IdentityNotificationCause.DROP_REPLIED,
  IdentityNotificationCause.ALL_DROPS,
  IdentityNotificationCause.PRIORITY_ALERT
];

/** A notification actor can be a voter/reactor rather than the drop's author. */
export async function publicCompetitionNotificationActor(
  notification: Pick<IdentityNotificationEntity, 'cause' | 'related_drop_id'>,
  identity: ApiIdentity
): Promise<ApiIdentity> {
  const dropId = notification.related_drop_id;
  if (!dropId || !DROP_AUTHOR_CAUSES.includes(notification.cause))
    return identity;
  const hiddenDropIds = await competitionAnonymityService.hiddenDropIds(
    [dropId],
    {},
    { includeOwner: true }
  );
  return hiddenDropIds.has(dropId)
    ? anonymousCompetitionAuthor(identity, dropId)
    : identity;
}
