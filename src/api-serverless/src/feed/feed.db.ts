import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import {
  ACTIVITY_EVENTS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE
} from '../../../constants';
import { ActivityEventEntity } from '../../../entities/IActivityEvent';

export class FeedDb extends LazyDbAccessCompatibleService {
  async getNextActivityEvents(
    params: {
      subscriber_id: string;
      visibility_group_ids: string[];
      limit: number;
      serial_no_less_than: number | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<ActivityEventEntity[]> {
    return this.db.execute<ActivityEventEntity>(
      `
      select ae.*
        from ${IDENTITY_SUBSCRIPTIONS_TABLE} ids
                 join ${ACTIVITY_EVENTS_TABLE} ae
                      on ids.target_id = ae.target_id and ids.target_type = ae.target_type and ids.target_action = ae.action
        where ae.action_author_id <> ids.subscriber_id and ${
          params.serial_no_less_than !== null
            ? `ae.id < :serial_no_less_than and `
            : ``
        } ids.subscriber_id = :subscriber_id and (
           ae.visibility_group_id is null
           ${
             params.visibility_group_ids.length
               ? `or ae.visibility_group_id in (:visibility_group_ids)`
               : ``
           }
        )
        order by ae.id desc
        limit :limit
      `,
      params,
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export const feedDb = new FeedDb(dbSupplier);
