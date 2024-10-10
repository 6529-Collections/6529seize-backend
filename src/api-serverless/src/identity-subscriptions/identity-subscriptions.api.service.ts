import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from './identity-subscriptions.db';
import { waveApiService, WaveApiService } from '../waves/wave.api.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import {
  IncomingIdentitySubscriptionsParams,
  OutgoingIdentitySubscriptionsParams
} from './identity-subscriptions.routes';
import { ApiOutgoingIdentitySubscriptionsPage } from '../generated/models/ApiOutgoingIdentitySubscriptionsPage';
import { ApiIncomingIdentitySubscriptionsPage } from '../generated/models/ApiIncomingIdentitySubscriptionsPage';
import { ApiIdentityAndSubscriptionActions } from '../generated/models/ApiIdentityAndSubscriptionActions';
import { assertUnreachable, resolveEnumOrThrow } from '../../../helpers';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import { ApiTargetAndSubscriptionActions } from '../generated/models/ApiTargetAndSubscriptionActions';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { AuthenticationContext } from '../../../auth-context';

export class IdentitySubscriptionsApiService {
  constructor(
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly wavesApiService: WaveApiService,
    private readonly dropsApiService: DropsApiService,
    private readonly profilesApiService: ProfilesApiService,
    private readonly userGroupsService: UserGroupsService
  ) {}

  public async findOutgoingSubscriptionsOfType(
    params: OutgoingIdentitySubscriptionsParams,
    authenticationContext: AuthenticationContext
  ): Promise<ApiOutgoingIdentitySubscriptionsPage> {
    const eligibleGroupIds =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        params.subscriber_id
      );
    const idsAndActions =
      await this.identitySubscriptionsDb.findTargetIdsAndActionsForTarget(
        params,
        eligibleGroupIds
      );
    const count =
      await this.identitySubscriptionsDb.countTargetIdsAndActionsForTarget(
        params,
        eligibleGroupIds
      );
    const entityIds = Object.keys(idsAndActions);
    const entities: ApiTargetAndSubscriptionActions[] = [];
    const targetType = params.target_type;
    switch (targetType) {
      case ActivityEventTargetType.WAVE: {
        const waves = await this.wavesApiService.findWavesByIdsOrThrow(
          entityIds,
          eligibleGroupIds,
          authenticationContext
        );
        entities.push(
          ...Object.entries(idsAndActions)
            .map(([id, actions]) => ({
              target: waves[id],
              actions: actions.map((it) =>
                resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
              )
            }))
            .sort((a, d) => d.target.id.localeCompare(a.target.id))
        );
        break;
      }
      case ActivityEventTargetType.DROP: {
        const drops = await this.dropsApiService.findDropsByIdsOrThrow(
          entityIds,
          authenticationContext
        );
        entities.push(
          ...Object.entries(idsAndActions)
            .map(([id, actions]) => ({
              target: drops[id],
              actions: actions.map((it) =>
                resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
              )
            }))
            .sort((a, d) => d.target.id.localeCompare(a.target.id))
        );
        break;
      }
      case ActivityEventTargetType.IDENTITY: {
        const profiles = await this.profilesApiService.getProfileMinsByIds({
          ids: entityIds,
          authenticatedProfileId: authenticationContext.getActingAsId()
        });
        entities.push(
          ...Object.entries(idsAndActions)
            .map(([id, actions]) => ({
              target: profiles[id],
              actions: actions.map((it) =>
                resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
              )
            }))
            .sort((a, d) => d.target.id.localeCompare(a.target.id))
        );
        break;
      }
      default: {
        assertUnreachable(targetType);
      }
    }
    return {
      data: entities,
      count,
      page: params.page,
      next: count > params.page_size * params.page
    };
  }

  async findIncomingSubscriptionsOfType(
    params: IncomingIdentitySubscriptionsParams
  ): Promise<ApiIncomingIdentitySubscriptionsPage> {
    const identityIdsAndActions =
      await this.identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget(
        params
      );
    const identityIds = Object.keys(identityIdsAndActions);
    const profiles = await this.profilesApiService.getProfileMinsByIds({
      ids: identityIds
    });
    const count =
      await this.identitySubscriptionsDb.countDistinctSubscriberIdsForTarget(
        params
      );
    const data: ApiIdentityAndSubscriptionActions[] = Object.entries(
      identityIdsAndActions
    )
      .map(([id, actions]) => ({
        identity: profiles[id],
        actions: actions.map((it) =>
          resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
        )
      }))
      .sort((a, d) => d.identity.level - a.identity.level);

    return {
      data,
      count,
      page: params.page,
      next: count > params.page_size * params.page
    };
  }
}

export const identitySubscriptionsApiService =
  new IdentitySubscriptionsApiService(
    identitySubscriptionsDb,
    waveApiService,
    dropsService,
    profilesApiService,
    userGroupsService
  );
