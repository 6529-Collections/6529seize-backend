import { profilesService } from '../../../profiles/profiles.service';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { ProfileMin } from '../generated/models/ProfileMin';
import { IdentitySubscriptionTargetAction } from '../generated/models/IdentitySubscriptionTargetAction';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { resolveEnumOrThrow } from '../../../helpers';

export class ProfilesApiService {
  constructor(
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  async getProfileMinsByIds(
    {
      ids,
      authenticatedProfileId
    }: { ids: string[]; authenticatedProfileId?: string | null },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ProfileMin>> {
    const profileOverviews = await profilesService.getProfileOverviewsByIds(
      ids,
      connection
    );
    const subscribedActions: Record<
      string,
      IdentitySubscriptionTargetAction[]
    > = authenticatedProfileId
      ? await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTargets(
            {
              subscriber_id: authenticatedProfileId,
              target_ids: ids,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            Object.entries(result).reduce((acc, [profileId, actions]) => {
              acc[profileId] = actions.map((it) =>
                resolveEnumOrThrow(IdentitySubscriptionTargetAction, it)
              );
              return acc;
            }, {} as Record<string, IdentitySubscriptionTargetAction[]>)
          )
      : {};
    return Object.values(profileOverviews).reduce((acc, profile) => {
      acc[profile.id] = {
        ...profile,
        subscribed_actions: subscribedActions[profile.id] || []
      };
      return acc;
    }, {} as Record<string, ProfileMin>);
  }
}

export const profilesApiService = new ProfilesApiService(
  identitySubscriptionsDb
);
