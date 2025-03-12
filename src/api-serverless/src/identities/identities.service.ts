import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { resolveEnumOrThrow } from '../../../helpers';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import { NotFoundException } from '../../../exceptions';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';

export class IdentitiesService {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly userNotifier: UserNotifier
  ) {}

  async addIdentitySubscriptionActions({
    subscriber,
    identityAddress,
    actions
  }: {
    subscriber: string;
    identityAddress: string;
    actions: ApiIdentitySubscriptionTargetAction[];
  }): Promise<ApiIdentitySubscriptionTargetAction[]> {
    const acceptedActions = actions.filter(
      (it) => it !== ApiIdentitySubscriptionTargetAction.DropVoted
    );
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .getEverythingRelatedToIdentitiesByAddresses(
            [identityAddress],
            connection
          )
          .then((it) => it[identityAddress]?.identity?.profile_id ?? null);
        if (!identityId) {
          throw new NotFoundException(`Identity ${identityAddress} not found`);
        }
        const proposedActions = Object.values(acceptedActions).map((it) =>
          resolveEnumOrThrow(ActivityEventAction, it)
        );

        const existingActions =
          await this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          );
        const actionsToAdd = proposedActions.filter(
          (it) => !existingActions.includes(it)
        );
        if (!existingActions.length) {
          await this.userNotifier.notifyOfIdentitySubscription(
            {
              subscriber_id: subscriber,
              subscribed_to: identityId
            },
            connection
          );
        }
        for (const action of actionsToAdd) {
          await this.identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: action,
              wave_id: null,
              subscribed_to_all_drops: false
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  async removeIdentitySubscriptionActions({
    subscriber,
    identityAddress,
    actions
  }: {
    subscriber: string;
    identityAddress: string;
    actions: ApiIdentitySubscriptionTargetAction[];
  }): Promise<ApiIdentitySubscriptionTargetAction[]> {
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .getEverythingRelatedToIdentitiesByAddresses(
            [identityAddress],
            connection
          )
          .then((it) => it[identityAddress]?.identity?.profile_id ?? null);
        if (!identityId) {
          throw new NotFoundException(`Identity ${identityAddress} not found`);
        }
        for (const action of actions) {
          await this.identitySubscriptionsDb.deleteIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: resolveEnumOrThrow(ActivityEventAction, action)
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(ApiIdentitySubscriptionTargetAction, it)
            )
          );
      }
    );
  }
}

export const identitiesService = new IdentitiesService(
  identitiesDb,
  identitySubscriptionsDb,
  userNotifier
);
