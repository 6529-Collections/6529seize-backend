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
import { IdentitySubscriptionTargetAction } from '../generated/models/IdentitySubscriptionTargetAction';
import { NotFoundException } from '../../../exceptions';

export class IdentitiesService {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  async addIdentitySubscriptionActions({
    subscriber,
    identityAddress,
    actions
  }: {
    subscriber: string;
    identityAddress: string;
    actions: IdentitySubscriptionTargetAction[];
  }): Promise<IdentitySubscriptionTargetAction[]> {
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .lockEverythingRelatedToIdentitiesByAddresses(
            [identityAddress],
            connection
          )
          .then((it) => it[identityAddress]?.identity?.profile_id ?? null);
        if (!identityId) {
          throw new NotFoundException(`Identity ${identityAddress} not found`);
        }
        const proposedActions = Object.values(actions).map((it) =>
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
        for (const action of actionsToAdd) {
          await this.identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: action
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
              resolveEnumOrThrow(IdentitySubscriptionTargetAction, it)
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
    actions: IdentitySubscriptionTargetAction[];
  }): Promise<IdentitySubscriptionTargetAction[]> {
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .lockEverythingRelatedToIdentitiesByAddresses(
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
              resolveEnumOrThrow(IdentitySubscriptionTargetAction, it)
            )
          );
      }
    );
  }
}

export const identitiesService = new IdentitiesService(
  identitiesDb,
  identitySubscriptionsDb
);
