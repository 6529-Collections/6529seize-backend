import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { distinct, resolveEnumOrThrow } from '../../../helpers';
import { Page, PageSortDirection } from '../page-request';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Drop } from '../generated/models/Drop';
import {
  DropActivityLog,
  DropActivityLogTypeEnum
} from '../generated/models/DropActivityLog';
import { ProfileMin } from '../generated/models/ProfileMin';
import { DropComment } from '../generated/models/DropComment';
import { Time } from '../../../time';
import {
  UserGroupsService,
  userGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '../../../auth-context';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { DropActivityLogsQuery } from './drop.validator';
import { WavesApiDb, wavesApiDb } from '../waves/waves.api.db';
import {
  activityRecorder,
  ActivityRecorder
} from '../../../activity/activity.recorder';
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
    private readonly wavesApiDb: WavesApiDb,
    private readonly activityRecorder: ActivityRecorder,
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
    authenticationContext
  }: {
    group_id: string | null;
    serial_no_less_than: number | null;
    wave_id: string | null;
    min_part_id: number;
    max_part_id: number;
    amount: number;
    author_id: string | null;
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
      author_id
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

  async findLogs(
    query: DropActivityLogsQuery,
    contextProfileId?: string | null
  ): Promise<Page<DropActivityLog>> {
    const [logs, count] = await Promise.all([
      this.dropsDb.findLogsByDropId(query),
      this.dropsDb
        .countLogsByDropIds([query.drop_id], query.log_type)
        .then((it) => it[query.drop_id] ?? 0)
    ]);
    const commentAuthorIds = logs.map((it) => it.profile_id);
    const profileMins = await this.profilesService.getProfileMinsByIds({
      ids: commentAuthorIds,
      authenticatedProfileId: contextProfileId
    });
    return {
      count,
      page: query.page,
      next: logs.length === query.page_size,
      data: logs.map((log) => ({
        ...log,
        created_at: Time.fromDate(log.created_at).toMillis(),
        target_id: log.target_id!,
        type: log.type as unknown as DropActivityLogTypeEnum,
        author: profileMins[log.profile_id] ?? null
      }))
    };
  }

  async commentDrop(commentRequest: {
    drop_id: string;
    drop_part_id: number;
    comment: string;
    author_id: string;
  }): Promise<DropComment> {
    const comment = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const commentId = await this.dropsDb.insertDiscussionComment(
          commentRequest,
          connection
        );
        const visibilityGroupId =
          await this.wavesApiDb.findWaveVisibilityGroupByDropId(
            commentRequest.drop_id,
            connection
          );
        await this.activityRecorder.recordDropCommented(
          {
            drop_id: commentRequest.drop_id,
            commenter_id: commentRequest.author_id,
            drop_part_id: commentRequest.drop_part_id,
            comment_id: commentId,
            visibility_group_id: visibilityGroupId
          },
          connection
        );
        const comment = await this.dropsDb.findDiscussionCommentById(
          commentId,
          connection
        );
        if (!comment) {
          throw new Error(
            `Something went wrong. Couldn't find the comment that was just inserted`
          );
        }
        const authorProfile = await this.profilesService
          .getProfileMinsByIds({
            ids: [comment.author_id],
            authenticatedProfileId: commentRequest.author_id
          })
          .then((it) => it[comment.author_id] ?? null);
        return {
          id: comment.id,
          author: authorProfile as ProfileMin,
          comment: comment.comment,
          created_at: comment.created_at
        };
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return comment;
  }

  async findDropPartComments(
    param: {
      sort_direction: PageSortDirection;
      drop_id: string;
      drop_part_id: number;
      sort: string;
      page: number;
      page_size: number;
    },
    authenticatedProfileId?: string | null
  ): Promise<Page<DropComment>> {
    const count = await this.dropsDb
      .countDiscussionCommentsByDropIds({ dropIds: [param.drop_id] })
      .then(
        (result) => result[param.drop_id]?.[param.drop_part_id]?.count ?? 0
      );
    const comments = await this.dropsDb.findDiscussionCommentsByDropId(param);
    const relatedProfiles = await this.profilesService.getProfileMinsByIds({
      ids: distinct(comments.map((it) => it.author_id)),
      authenticatedProfileId
    });
    return {
      count,
      page: param.page,
      next: count > param.page_size * param.page,
      data: comments.map((comment) => ({
        id: comment.id,
        comment: comment.comment,
        created_at: comment.created_at,
        author: relatedProfiles[comment.author_id]!
      }))
    };
  }

  async findCommentsByIds(
    ids: number[],
    authenticatedProfileId?: string | null
  ): Promise<Record<number, DropComment>> {
    const comments = await this.dropsDb.findDiscussionCommentsByIds(ids);
    const relatedProfiles = await this.profilesService.getProfileMinsByIds({
      ids: distinct(comments.map((it) => it.author_id)),
      authenticatedProfileId
    });
    return comments
      .map<DropComment>((comment) => ({
        id: comment.id,
        comment: comment.comment,
        created_at: comment.created_at,
        author: relatedProfiles[comment.author_id]!
      }))
      .reduce((acc, comment) => {
        acc[comment.id] = comment;
        return acc;
      }, {} as Record<number, DropComment>);
  }

  async findDropsByIdsOrThrow(
    dropIds: string[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, Drop>> {
    const dropEntities = await this.dropsDb.getDropsByIds(dropIds, connection);
    const missingDrops = dropIds.filter(
      (it) => !dropEntities.find((e) => e.id === it)
    );
    if (missingDrops.length) {
      throw new NotFoundException(
        `Drop(s) not found: ${missingDrops.join(', ')}`
      );
    }
    return this.dropsMappers
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
  wavesApiDb,
  activityRecorder,
  identitySubscriptionsDb
);
