import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from './identity-subscriptions.db';
import { waveApiService, WaveApiService } from '../waves/wave.api.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import {
  IncomingIdentitySubscriptionsParams,
  OutgoingIdentitySubscriptionsParams
} from './identity-subscriptions.routes';
import { ApiOutgoingIdentitySubscriptionsPage } from '../generated/models/ApiOutgoingIdentitySubscriptionsPage';
import { ApiIncomingIdentitySubscriptionsPage } from '../generated/models/ApiIncomingIdentitySubscriptionsPage';
import { ApiIdentityAndSubscriptionActions } from '../generated/models/ApiIdentityAndSubscriptionActions';
import { assertUnreachable } from '../../../assertions';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import { ApiTargetAndSubscriptionActions } from '../generated/models/ApiTargetAndSubscriptionActions';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import { AuthenticationContext } from '../../../auth-context';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { RequestContext } from '@/request.context';
import {
  waveFollowerEligibilityService,
  WaveFollowerEligibilityService
} from '@/api/identity-subscriptions/wave-follower-eligibility';
import { NotFoundException } from '@/exceptions';
import { dropsDb as defaultDropsDb, DropsDb } from '@/drops/drops.db';
import {
  wavesApiDb as defaultWavesApiDb,
  WavesApiDb
} from '@/api/waves/waves.api.db';
import {
  assertWaveAndParentVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext
} from '@/api/waves/wave-access.helpers';
import {
  competitionAnonymityService,
  CompetitionAnonymityService,
  competitionAnonymityViewerId
} from '@/competitions/competition-anonymity';

export class IdentitySubscriptionsApiService {
  constructor(
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly wavesApiService: WaveApiService,
    private readonly dropsApiService: DropsApiService,
    private readonly identityFetcher: IdentityFetcher,
    private readonly userGroupsService: UserGroupsService,
    private readonly followerEligibility: WaveFollowerEligibilityService = waveFollowerEligibilityService,
    private readonly wavesApiDb: WavesApiDb = defaultWavesApiDb,
    private readonly dropsDb: DropsDb = defaultDropsDb,
    private readonly competitionAnonymity: CompetitionAnonymityService = competitionAnonymityService
  ) {}

  public async findOutgoingSubscriptionsOfType(
    params: OutgoingIdentitySubscriptionsParams,
    authenticationContext: AuthenticationContext
  ): Promise<ApiOutgoingIdentitySubscriptionsPage> {
    const eligibleGroupIds = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      { authenticationContext }
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
                enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
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
                enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
              )
            }))
            .sort((a, d) => d.target.id.localeCompare(a.target.id))
        );
        break;
      }
      case ActivityEventTargetType.IDENTITY: {
        const profiles = await this.identityFetcher.getOverviewsByIds(
          entityIds,
          { authenticationContext }
        );
        entities.push(
          ...Object.entries(idsAndActions)
            .map(([id, actions]) => ({
              target: profiles[id],
              actions: actions.map((it) =>
                enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
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
    params: IncomingIdentitySubscriptionsParams,
    ctx: RequestContext
  ): Promise<ApiIncomingIdentitySubscriptionsPage> {
    const excludedSubscriberId =
      await this.assertTargetReadableAndGetHiddenSubscriber(params, ctx);
    const eligibility =
      params.target_type === ActivityEventTargetType.WAVE
        ? await this.followerEligibility.resolve(params.target_id, ctx)
        : [];
    const identityIdsAndActions =
      await this.identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget(
        params,
        eligibility,
        ctx,
        excludedSubscriberId
      );
    const identityIds = Object.keys(identityIdsAndActions);
    const profiles = await this.identityFetcher.getOverviewsByIds(
      identityIds,
      {}
    );
    const count =
      await this.identitySubscriptionsDb.countDistinctSubscriberIdsForTarget(
        params,
        eligibility,
        ctx,
        excludedSubscriberId
      );
    const data: ApiIdentityAndSubscriptionActions[] = Object.entries(
      identityIdsAndActions
    )
      .map(([id, actions]) => ({
        identity: profiles[id],
        actions: actions.map((it) =>
          enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
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

  /**
   * Wave and drop subscribers are only listed when the viewer can read the
   * wave (and its parent). For an anonymous competition entry the author's
   * own subscription is left out, so the listing cannot reveal the author,
   * except when the viewer is that author.
   */
  private async assertTargetReadableAndGetHiddenSubscriber(
    params: IncomingIdentitySubscriptionsParams,
    ctx: RequestContext
  ): Promise<string | null> {
    const targetType = params.target_type;
    if (targetType === ActivityEventTargetType.IDENTITY) {
      return null;
    }
    const notFoundMessage = `${targetType} ${params.target_id} not found`;
    const drop =
      targetType === ActivityEventTargetType.DROP
        ? await this.dropsDb.findDropById(params.target_id, ctx.connection)
        : null;
    const waveId =
      targetType === ActivityEventTargetType.DROP
        ? (drop?.wave_id ?? null)
        : params.target_id;
    if (!waveId) {
      throw new NotFoundException(notFoundMessage);
    }
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    await assertWaveAndParentVisibleOrThrow({
      wave: await this.wavesApiDb.findWaveById(waveId, ctx.connection),
      groupsUserIsEligibleFor,
      message: notFoundMessage,
      wavesApiDb: this.wavesApiDb,
      ctx
    });
    if (!drop) {
      return null;
    }
    // The author may always see their own subscription; resolve the viewer
    // the same way competition anonymity does so proxies keep the exclusion
    // unless they can read waves on the author's behalf.
    if (competitionAnonymityViewerId(ctx) === drop.author_id) {
      return null;
    }
    const hiddenDropIds = await this.competitionAnonymity.hiddenDropIds(
      [drop.id],
      ctx
    );
    return hiddenDropIds.has(drop.id) ? drop.author_id : null;
  }
}

export const identitySubscriptionsApiService =
  new IdentitySubscriptionsApiService(
    identitySubscriptionsDb,
    waveApiService,
    dropsService,
    identityFetcher,
    userGroupsService
  );
