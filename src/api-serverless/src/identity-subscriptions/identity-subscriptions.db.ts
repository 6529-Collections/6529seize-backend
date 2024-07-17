import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { IdentitySubscriptionEntity } from '../../../entities/IIdentitySubscription';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { IDENTITY_SUBSCRIPTIONS_TABLE } from '../../../constants';

export class IdentitySubscriptionsDb extends LazyDbAccessCompatibleService {
  async addIdentitySubscription(
    identitySubscription: Omit<IdentitySubscriptionEntity, 'id'>,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      insert into ${IDENTITY_SUBSCRIPTIONS_TABLE} (subscriber_id, target_id, target_type, target_action)
      values (:subscriber_id, :target_id, :target_type, :target_action)
    `,
      identitySubscription,
      {
        wrappedConnection: connection
      }
    );
  }

  async findIdentitySubscriptionActionsOfTarget(
    param: {
      subscriber_id: string;
      target_id: string;
      target_type: ActivityEventTargetType;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<ActivityEventAction[]> {
    return this.db
      .execute<{ target_action: ActivityEventAction }>(
        `
      select target_action from ${IDENTITY_SUBSCRIPTIONS_TABLE} 
      where subscriber_id = :subscriber_id 
      and target_id = :target_id and target_type = :target_type`,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it.map((it) => it.target_action));
  }

  async deleteIdentitySubscription(
    param: {
      subscriber_id: string;
      target_type: ActivityEventTargetType;
      target_id: string;
      target_action: ActivityEventAction;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      delete from ${IDENTITY_SUBSCRIPTIONS_TABLE}
      where subscriber_id = :subscriber_id
      and target_id = :target_id
      and target_type = :target_type
      and target_action = :target_action
    `,
      param,
      {
        wrappedConnection: connection
      }
    );
  }
}

export const identitySubscriptionsDb = new IdentitySubscriptionsDb(dbSupplier);
