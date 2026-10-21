import { RequestContext } from '@/request.context';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb,
  SubscriberEligibility
} from '@/api/identity-subscriptions/identity-subscriptions.db';

export class WaveFollowerEligibilityService {
  constructor(
    private readonly subscriptions: Pick<
      IdentitySubscriptionsDb,
      'findWaveFollowerReadGroups'
    >,
    private readonly groups: Pick<
      UserGroupsService,
      'getSqlAndParamsByGroupIdForSystemBroadcast'
    >
  ) {}

  async resolve(
    waveId: string,
    ctx: RequestContext
  ): Promise<SubscriberEligibility> {
    const groupIds = await this.subscriptions.findWaveFollowerReadGroups(
      waveId,
      ctx
    );
    if (groupIds === null) return null;
    // Public waves use the original indexed subscription query. Restricted
    // waves build membership SQL per access group, never per follower.
    const memberships = await Promise.all(
      groupIds.map(async (key) => {
        const membership =
          await this.groups.getSqlAndParamsByGroupIdForSystemBroadcast(
            key,
            ctx
          );
        return membership ? { key, ...membership } : null;
      })
    );
    if (memberships.some((membership) => membership === null)) return null;
    return memberships.filter((membership) => membership !== null);
  }
}

export const waveFollowerEligibilityService =
  new WaveFollowerEligibilityService(
    identitySubscriptionsDb,
    userGroupsService
  );
