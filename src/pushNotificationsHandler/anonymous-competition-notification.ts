import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import {
  anonymousCompetitionAuthor,
  competitionAnonymityService
} from '@/competitions/competition-anonymity';
import { IdentityNotificationEntity } from '@/entities/IIdentityNotification';
import { anonymousNotificationActorDropId } from '@/notifications/anonymous-notification-actor';
import { RequestContext } from '@/request.context';

type Notification = Pick<
  IdentityNotificationEntity,
  'cause' | 'related_drop_id'
>;
export type CompetitionNotificationActorResolver = (
  notification: Notification,
  identity: ApiIdentity
) => ApiIdentity;

/** One authoritative policy snapshot serves every recipient in a push batch. */
export async function createCompetitionNotificationActorResolver(
  notifications: readonly Notification[],
  ctx: RequestContext
): Promise<CompetitionNotificationActorResolver> {
  const dropIds = Array.from(
    new Set(
      notifications.flatMap((notification) => {
        const dropId = anonymousNotificationActorDropId(notification);
        return dropId ? [dropId] : [];
      })
    )
  );
  const hiddenDropIds = dropIds.length
    ? await competitionAnonymityService.hiddenDropIds(dropIds, ctx, {
        includeOwner: true
      })
    : new Set<string>();
  return (notification, identity) => {
    const dropId = anonymousNotificationActorDropId(notification);
    return dropId && hiddenDropIds.has(dropId)
      ? anonymousCompetitionAuthor(identity, dropId)
      : identity;
  };
}

/** A notification actor can be a voter/reactor rather than the drop's author. */
export async function publicCompetitionNotificationActor(
  notification: Notification,
  identity: ApiIdentity,
  ctx: RequestContext = {}
): Promise<ApiIdentity> {
  const resolveActor = await createCompetitionNotificationActorResolver(
    [notification],
    ctx
  );
  return resolveActor(notification, identity);
}
