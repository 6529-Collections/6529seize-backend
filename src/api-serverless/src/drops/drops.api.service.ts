import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { NotFoundException } from '../../../exceptions';
import { resolveEnumOrThrow } from '../../../helpers';
import { Page, PageSortDirection } from '../page-request';
import { Drop } from '../generated/models/Drop';
import {
  UserGroupsService,
  userGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { DropSubscriptionTargetAction } from '../generated/models/DropSubscriptionTargetAction';
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
import { WaveMin } from '../generated/models/WaveMin';
import { WaveDropsFeed } from '../generated/models/WaveDropsFeed';
import { DropTraceItem } from '../generated/models/DropTraceItem';
import { DropSearchStrategy } from '../generated/models/DropSearchStrategy';

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
  ): Promise<Drop> {
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
      include_replies
    }: {
      group_id: string | null;
      serial_no_less_than: number | null;
      wave_id: string | null;
      amount: number;
      author_id: string | null;
      include_replies: boolean;
    },
    ctx: RequestContext
  ): Promise<Drop[]> {
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
        include_replies
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
      !authenticationContext.hasProxyAction(ApiProfileProxyActionType.READ_WAVE)
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
      sort: string;
      page: number;
      page_size: number;
    },
    ctx: RequestContext
  ): Promise<Page<Drop>> {
    const count = await this.dropsDb
      .countRepliesByDropIds({ dropIds: [param.drop_id] })
      .then(
        (result) => result[param.drop_id]?.[param.drop_part_id]?.count ?? 0
      );
    const replies = await this.dropsDb.findRepliesByDropId(param);
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
  ): Promise<Record<string, Drop>> {
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
  ) {
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
        }, {} as Record<string, Drop>)
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
    actions: DropSubscriptionTargetAction[];
    authenticationContext: AuthenticationContext;
  }): Promise<DropSubscriptionTargetAction[]> {
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
              resolveEnumOrThrow(DropSubscriptionTargetAction, it)
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
    actions: DropSubscriptionTargetAction[];
  }): Promise<DropSubscriptionTargetAction[]> {
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
              resolveEnumOrThrow(DropSubscriptionTargetAction, it)
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
      search_strategy
    }: {
      drop_id: string | null;
      serial_no_limit: number | null;
      wave_id: string;
      amount: number;
      search_strategy: DropSearchStrategy;
    },
    ctx: RequestContext
  ): Promise<WaveDropsFeed> {
    ctx.timer?.start('dropsApiService->findWaveDropsFeed');
    const authenticationContext = ctx.authenticationContext!;
    const context_profile_id = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      !authenticationContext.isUserFullyAuthenticated() ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.hasProxyAction(
          ApiProfileProxyActionType.READ_WAVE
        ))
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
    const waveMin: WaveMin = {
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
          search_strategy
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
      const resp: WaveDropsFeed = {
        drops,
        wave: waveMin,
        trace: trace.map<DropTraceItem>((it) => ({
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
          search_strategy
        },
        ctx
      );
      const drops = await this.dropsMappers.convertToDropsWithoutWaves(
        dropEntities,
        ctx
      );
      const resp: WaveDropsFeed = {
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
