import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { ACTIVITY_EVENTS_TABLE } from '../../../constants';
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
      SELECT STRAIGHT_JOIN ae.*
      FROM ${ACTIVITY_EVENTS_TABLE} ae
               FORCE INDEX (PRIMARY)
      WHERE
         (:serial_no_less_than is null or ae.id < :serial_no_less_than)
      
        AND ae.action_author_id <> :subscriber_id
      
        AND (
          ae.visibility_group_id IS NULL
          ${
            params.visibility_group_ids.length
              ? `or ae.visibility_group_id in (:visibility_group_ids)`
              : ``
          }
          )
      
        AND EXISTS (
          SELECT 1
          FROM identity_subscriptions ids
          WHERE ids.subscriber_id  = :subscriber_id
            AND ids.target_id     = ae.target_id
            AND ids.target_type   = ae.target_type
            AND ids.target_action = ae.action
      )
      ORDER BY ae.id DESC
      LIMIT :limit
    `,
      params,
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export const feedDb = new FeedDb(dbSupplier);
