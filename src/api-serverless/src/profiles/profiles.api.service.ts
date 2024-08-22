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
import { Timer } from '../../../time';

export class ProfilesApiService {
  constructor(
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  async getProfileMinsByIds(
    {
      ids,
      authenticatedProfileId,
      timer
    }: { ids: string[]; authenticatedProfileId?: string | null; timer?: Timer },
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ProfileMin>> {
    timer?.start('profilesApiService->getProfileMinsByIds');
    timer?.start(
      'profilesApiService->getProfileMinsByIds->getProfileOverviewsByIds'
    );
    const profileOverviews = await profilesService.getProfileOverviewsByIds(
      ids,
      connection
    );
    timer?.stop(
      'profilesApiService->getProfileMinsByIds->getProfileOverviewsByIds'
    );
    timer?.start(
      'profilesApiService->getProfileMinsByIds->findIdentitySubscriptionActionsOfTargets'
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
    timer?.stop(
      'profilesApiService->getProfileMinsByIds->findIdentitySubscriptionActionsOfTargets'
    );
    timer?.stop('profilesApiService->getProfileMinsByIds');
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
