import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { ACTIVITY_EVENTS_TABLE } from '@/constants';
import {
  ActivityEventAction,
  ActivityEventEntity
} from '../../../entities/IActivityEvent';

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
    const visibilityFilter = params.visibility_group_ids.length
      ? `or ae.visibility_group_id in (:visibility_group_ids)`
      : ``;

    return this.db.execute<ActivityEventEntity>(
      `
      SELECT STRAIGHT_JOIN ae.*
      FROM ${ACTIVITY_EVENTS_TABLE} ae
               FORCE INDEX (PRIMARY)
      WHERE
         (:serial_no_less_than is null or ae.id < :serial_no_less_than)
      
        AND (
          ae.visibility_group_id IS NULL
          ${visibilityFilter}
          )
      
        AND (
          -- Subscribed events from other users
          (ae.action_author_id <> :subscriber_id
           AND EXISTS (
             SELECT 1
             FROM identity_subscriptions ids
             WHERE ids.subscriber_id = :subscriber_id
               AND ids.target_id = ae.target_id
               AND ids.target_type = ae.target_type
               AND ids.target_action = ae.action
           ))
          
          OR
          
          -- User's own DROP_CREATED messages
          (ae.action_author_id = :subscriber_id
           AND ae.action = :drop_created_action)
        )
      
      ORDER BY ae.id DESC
      LIMIT :limit
      `,
      {
        ...params,
        drop_created_action: ActivityEventAction.DROP_CREATED
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async getNextPublicFeedActivityEvents(
    params: {
      wave_ids: string[];
      limit: number;
      serial_no_less_than: number | null;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<ActivityEventEntity[]> {
    if (params.wave_ids.length === 0) {
      return [];
    }
    return this.db.execute<ActivityEventEntity>(
      `
    SELECT ae.*
    FROM ${ACTIVITY_EVENTS_TABLE} ae
    WHERE
       (:serial_no_less_than is null or ae.id < :serial_no_less_than)
    
      AND ae.visibility_group_id IS NULL
    
      AND ae.wave_id in (:wave_ids)
    
    ORDER BY ae.id DESC
    LIMIT :limit
    `,
      {
        ...params,
        drop_created_action: ActivityEventAction.DROP_CREATED
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }
}

export const feedDb = new FeedDb(dbSupplier);
