import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { NotFoundException } from '../../../exceptions';
import { resolveEnumOrThrow } from '../../../helpers';
import { Page, PageSortDirection } from '../page-request';
import { ApiDrop } from '../generated/models/ApiDrop';
import {
  UserGroupsService,
  userGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { ApiDropSubscriptionTargetAction } from '../generated/models/ApiDropSubscriptionTargetAction';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { dropsMappers, DropsMappers } from './drops.mappers';
import { RequestContext } from '../../../request.context';
import { wavesApiDb } from '../waves/waves.api.db';
import { ApiWaveMin } from '../generated/models/ApiWaveMin';
import { ApiDropTraceItem } from '../generated/models/ApiDropTraceItem';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '../generated/models/ApiDropType';
import { DropType } from '../../../entities/IDrop';
import { ApiWaveDropsFeed } from '../generated/models/ApiWaveDropsFeed';

export class DropsApiService {
  constructor(
    private readonly dropsMappers: DropsMappers,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      skipEligibilityCheck
    }: {
      dropId: string;
      skipEligibilityCheck?: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const contextProfileId = this.getDropsReadContextProfileId(
      ctx.authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(contextProfileId);
    const dropEntity = await (skipEligibilityCheck
      ? this.dropsDb.findDropByIdWithoutEligibilityCheck(dropId, ctx.connection)
      : this.dropsDb.findDropByIdWithEligibilityCheck(
          dropId,
          group_ids_user_is_eligible_for,
          ctx.connection
        )
    ).then(async (drop) => {
      if (!drop) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }

      return drop;
    });
    return this.dropsMappers
      .convertToDropFulls(
        {
          dropEntities: [dropEntity],
          contextProfileId: contextProfileId
        },
        ctx.connection
      )
      .then((it) => it[0]);
  }

  public async findLatestDrops(
    {
      amount,
      group_id,
      wave_id,
      serial_no_less_than,
      author_id,
      include_replies,
      drop_type
    }: {
      group_id: string | null;
      serial_no_less_than: number | null;
      wave_id: string | null;
      amount: number;
      author_id: string | null;
      include_replies: boolean;
      drop_type: ApiDropType | null;
    },
    ctx: RequestContext
  ): Promise<ApiDrop[]> {
    const authenticationContext = ctx.authenticationContext;
    const context_profile_id = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        context_profile_id
      );
    if (group_id && !group_ids_user_is_eligible_for.includes(group_id)) {
      return [];
    }
    const dropEntities = await this.dropsDb.findLatestDrops(
      {
        amount,
        serial_no_less_than,
        group_id,
        group_ids_user_is_eligible_for,
        wave_id,
        author_id,
        include_replies,
        drop_type: drop_type ? resolveEnumOrThrow(DropType, drop_type) : null
      },
      ctx
    );
    return await this.dropsMappers.convertToDropFulls({
      dropEntities: dropEntities,
      contextProfileId: context_profile_id
    });
  }

  private getDropsReadContextProfileId(
    authenticationContext?: AuthenticationContext
  ): string | null {
    if (!authenticationContext?.isUserFullyAuthenticated()) {
      return null;
    }
    const context_profile_id = authenticationContext.getActingAsId()!;
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.hasProxyAction(ProfileProxyActionType.READ_WAVE)
    ) {
      return null;
    }
    return context_profile_id;
  }

  async findAvailableCreditForRatingForProfile(
    profileId: string
  ): Promise<{ available_credit_for_rating: number }> {
    const creditLeft = await this.dropsDb.findCreditLeftForDropsForProfile({
      profileId
    });
    return { available_credit_for_rating: creditLeft };
  }

  async findDropReplies(
    param: {
      sort_direction: PageSortDirection;
      drop_id: string;
      drop_part_id: number;
      drop_type: ApiDropType | null;
      sort: string;
      page: number;
      page_size: number;
    },
    ctx: RequestContext
  ): Promise<Page<ApiDrop>> {
    const drop_type = param.drop_type
      ? resolveEnumOrThrow(DropType, param.drop_type)
      : null;
    const count = await this.dropsDb
      .countRepliesByDropIds({
        dropIds: [param.drop_id],
        drop_type
      })
      .then(
        (result) => result[param.drop_id]?.[param.drop_part_id]?.count ?? 0
      );
    const replies = await this.dropsDb.findRepliesByDropId({
      ...param,
      drop_type
    });
    const drops = await this.dropsMappers.convertToDropFulls({
      dropEntities: replies,
      contextProfileId: ctx.authenticationContext?.getActingAsId()
    });
    return {
      count,
      page: param.page,
      next: count > param.page_size * param.page,
      data: drops
    };
  }

  async findDropsByIdsOrThrow(
    dropIds: string[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ApiDrop>> {
    const result = await this.findDropsByIds(
      dropIds,
      authenticationContext,
      connection
    );
    const dropFulls = Object.values(result);
    const missingDrops = dropIds.filter(
      (it) => !dropFulls.find((e) => e.id === it)
    );
    if (missingDrops.length) {
      throw new NotFoundException(
        `Drop(s) not found: ${missingDrops.join(', ')}`
      );
    }
    return result;
  }

  public async findDropsByIds(
    dropIds: string[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ApiDrop>> {
    const dropEntities = await this.dropsDb.getDropsByIds(dropIds, connection);
    return await this.dropsMappers
      .convertToDropFulls({
        dropEntities,
        contextProfileId: authenticationContext?.getActingAsId()
      })
      .then((drops) =>
        drops.reduce((acc, drop) => {
          acc[drop.id] = drop;
          return acc;
        }, {} as Record<string, ApiDrop>)
      );
  }

  async addDropSubscriptionActions({
    subscriber,
    dropId,
    actions,
    authenticationContext
  }: {
    subscriber: string;
    dropId: string;
    actions: ApiDropSubscriptionTargetAction[];
    authenticationContext: AuthenticationContext;
  }): Promise<ApiDropSubscriptionTargetAction[]> {
    const waveId = await this.findDropByIdOrThrow(
      {
        dropId
      },
      { authenticationContext }
    ).then((it) => it.wave.id);
    const proposedActions = Object.values(actions).map((it) =>
      resolveEnumOrThrow(ActivityEventAction, it)
    );
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const existingActions =
          await this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          );
        const actionsToAdd = proposedActions.filter(
          (it) => !existingActions.includes(it)
        );
        for (const action of actionsToAdd) {
          await this.identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP,
              target_action: action,
              wave_id: waveId
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(ApiDropSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  async removeDropSubscriptionActions({
    subscriber,
    dropId,
    authenticationContext,
    actions
  }: {
    subscriber: string;
    dropId: string;
    authenticationContext: AuthenticationContext;
    actions: ApiDropSubscriptionTargetAction[];
  }): Promise<ApiDropSubscriptionTargetAction[]> {
    await this.findDropByIdOrThrow(
      {
        dropId
      },
      { authenticationContext }
    );
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        for (const action of actions) {
          await this.identitySubscriptionsDb.deleteIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP,
              target_action: resolveEnumOrThrow(ActivityEventAction, action)
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(ApiDropSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  public async findWaveDropsFeed(
    {
      drop_id,
      wave_id,
      serial_no_limit,
      amount,
      search_strategy,
      drop_type
    }: {
      drop_id: string | null;
      serial_no_limit: number | null;
      wave_id: string;
      amount: number;
      search_strategy: ApiDropSearchStrategy;
      drop_type: ApiDropType | null;
    },
    ctx: RequestContext
  ): Promise<ApiWaveDropsFeed> {
    ctx.timer?.start('dropsApiService->findWaveDropsFeed');
    const authenticationContext = ctx.authenticationContext!;
    const context_profile_id = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      !authenticationContext.isUserFullyAuthenticated() ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.hasProxyAction(ProfileProxyActionType.READ_WAVE))
        ? []
        : await this.userGroupsService.getGroupsUserIsEligibleFor(
            context_profile_id
          );
    const wave = await wavesApiDb.findWaveById(wave_id);
    if (
      !wave ||
      (wave.visibility_group_id &&
        !group_ids_user_is_eligible_for.includes(wave.visibility_group_id))
    ) {
      throw new NotFoundException(`Wave ${wave_id} not found`);
    }
    const waveMin: ApiWaveMin = {
      id: wave.id,
      name: wave.name,
      picture: wave.picture!,
      description_drop_id: wave.description_drop_id,
      authenticated_user_eligible_to_vote:
        wave.voting_group_id === null ||
        group_ids_user_is_eligible_for.includes(wave.voting_group_id),
      authenticated_user_eligible_to_participate:
        wave.participation_group_id === null ||
        group_ids_user_is_eligible_for.includes(wave.participation_group_id)
    };
    if (drop_id) {
      const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
        drop_id,
        group_ids_user_is_eligible_for,
        ctx.connection
      );
      if (!dropEntity || dropEntity.wave_id !== wave_id) {
        throw new NotFoundException(`Drop ${drop_id} not found`);
      }
      const trace = await this.dropsDb.getTraceForDrop(drop_id, ctx);
      const dropEntities = await this.dropsDb.findLatestDropRepliesSimple(
        {
          drop_id: drop_id,
          amount,
          serial_no_limit,
          search_strategy,
          drop_type: drop_type ? resolveEnumOrThrow(DropType, drop_type) : null
        },
        ctx
      );
      const drops = await this.dropsMappers.convertToDropsWithoutWaves(
        dropEntities,
        ctx
      );
      const rootDrop = await this.dropsMappers
        .convertToDropsWithoutWaves([dropEntity], ctx)
        .then((it) => it[0]!);
      const resp: ApiWaveDropsFeed = {
        drops,
        wave: waveMin,
        trace: trace.map<ApiDropTraceItem>((it) => ({
          drop_id: it.drop_id,
          is_deleted: it.is_deleted
        })),
        root_drop: rootDrop
      };
      ctx.timer?.stop('dropsApiService->findWaveDropsFeed');
      return resp;
    } else {
      const dropEntities = await this.dropsDb.findLatestDropsSimple(
        {
          wave_id: wave.id,
          amount,
          serial_no_limit,
          search_strategy,
          drop_type: drop_type ? resolveEnumOrThrow(DropType, drop_type) : null
        },
        ctx
      );
      const drops = await this.dropsMappers.convertToDropsWithoutWaves(
        dropEntities,
        ctx
      );
      const resp: ApiWaveDropsFeed = {
        drops,
        wave: waveMin
      };
      ctx.timer?.stop('dropsApiService->findWaveDropsFeed');
      return resp;
    }
  }
}

export const dropsService = new DropsApiService(
  dropsMappers,
  dropsDb,
  userGroupsService,
  identitySubscriptionsDb
);
