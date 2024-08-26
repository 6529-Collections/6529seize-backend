import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
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
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { dropsMappers, DropsMappers } from './drops.mappers';

export class DropsApiService {
  constructor(
    private readonly dropsMappers: DropsMappers,
    private readonly dropsDb: DropsDb,
    private readonly profilesService: ProfilesApiService,
    private readonly userGroupsService: UserGroupsService,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      authenticationContext,
      min_part_id,
      max_part_id,
      skipEligibilityCheck
    }: {
      dropId: string;
      authenticationContext?: AuthenticationContext;
      min_part_id: number;
      max_part_id: number;
      skipEligibilityCheck?: boolean;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<Drop> {
    const contextProfileId = this.getDropsReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(contextProfileId);
    const dropEntity = await (skipEligibilityCheck
      ? this.dropsDb.findDropByIdWithoutEligibilityCheck(dropId, connection)
      : this.dropsDb.findDropById(
          dropId,
          group_ids_user_is_eligible_for,
          connection
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
          contextProfileId: contextProfileId,
          min_part_id,
          max_part_id
        },
        connection
      )
      .then((it) => it[0]);
  }

  public async findLatestDrops({
    amount,
    group_id,
    wave_id,
    serial_no_less_than,
    min_part_id,
    max_part_id,
    author_id,
    include_replies,
    authenticationContext
  }: {
    group_id: string | null;
    serial_no_less_than: number | null;
    wave_id: string | null;
    min_part_id: number;
    max_part_id: number;
    amount: number;
    author_id: string | null;
    include_replies: boolean;
    authenticationContext?: AuthenticationContext;
  }): Promise<Drop[]> {
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
    const dropEntities = await this.dropsDb.findLatestDrops({
      amount,
      serial_no_less_than,
      group_id,
      group_ids_user_is_eligible_for,
      wave_id,
      author_id,
      include_replies
    });
    return await this.dropsMappers.convertToDropFulls({
      dropEntities: dropEntities,
      contextProfileId: context_profile_id,
      min_part_id,
      max_part_id
    });
  }

  private getDropsReadContextProfileId(
    authenticationContext?: AuthenticationContext
  ): string | null {
    if (!authenticationContext) {
      return null;
    }
    const context_profile_id = authenticationContext.getActingAsId();
    if (!context_profile_id) {
      throw new ForbiddenException(
        `Please create a profile before browsing drops`
      );
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
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
    authenticatedProfileId?: string | null
  ): Promise<Page<Drop>> {
    const count = await this.dropsDb
      .countRepliesByDropIds({ dropIds: [param.drop_id] })
      .then(
        (result) => result[param.drop_id]?.[param.drop_part_id]?.count ?? 0
      );
    const replies = await this.dropsDb.findRepliesByDropId(param);
    const drops = await this.dropsMappers.convertToDropFulls({
      dropEntities: replies,
      contextProfileId: authenticatedProfileId,
      min_part_id: 1,
      max_part_id: Number.MAX_SAFE_INTEGER
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
        contextProfileId: authenticationContext?.getActingAsId(),
        min_part_id: 1,
        max_part_id: Number.MAX_SAFE_INTEGER
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
    await this.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id: 1,
      max_part_id: 1
    });
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
              target_action: action
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
    await this.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id: 1,
      max_part_id: 1
    });
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
}

export const dropsService = new DropsApiService(
  dropsMappers,
  dropsDb,
  profilesApiService,
  userGroupsService,
  identitySubscriptionsDb
);
