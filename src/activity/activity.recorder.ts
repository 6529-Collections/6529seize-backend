import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { NewActivityEvent } from './new-activity-event';
import { ACTIVITY_EVENTS_TABLE } from '../constants';
import { Time } from '../time';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../entities/IActivityEvent';

const mysql = require('mysql');

const ACTIVITY_EVENT_ACTIONS_BY_TYPE: Record<
  ActivityEventTargetType,
  ActivityEventAction[]
> = {
  [ActivityEventTargetType.IDENTITY]: [
    ActivityEventAction.WAVE_CREATED,
    ActivityEventAction.DROP_CREATED,
    ActivityEventAction.DROP_COMMENTED,
    ActivityEventAction.DROP_VOTED
  ],
  [ActivityEventTargetType.WAVE]: [ActivityEventAction.DROP_CREATED],
  [ActivityEventTargetType.DROP]: [
    ActivityEventAction.DROP_COMMENTED,
    ActivityEventAction.DROP_VOTED
  ]
};

class ActivityRecorder extends LazyDbAccessCompatibleService {
  async recordEvents(
    events: NewActivityEvent[],
    connection?: ConnectionWrapper<any>
  ) {
    if (!events.length) {
      return;
    }
    this.validateEvents(events);
    const now = Time.currentMillis();
    const sql = `
        insert into ${ACTIVITY_EVENTS_TABLE} (
            target_id,
            target_type,
            action,
            data,
            visibility_group_id,
            created_at
        ) values ${events
          .map(
            (event) =>
              `(${mysql.escape(event.target_id)}, ${mysql.escape(
                event.target_type
              )}, ${mysql.escape(event.action)}, ${mysql.escape(
                JSON.stringify(event.data)
              )}, ${mysql.escape(event.visibility_group_id)}, ${now})`
          )
          .join(', ')}
    `;
    await this.db.execute(
      sql,
      undefined,
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async recordEvent(
    event: NewActivityEvent,
    connection?: ConnectionWrapper<any>
  ) {
    await this.recordEvents([event], connection);
  }

  private validateEvents(events: NewActivityEvent[]) {
    const invalidEvent = events.find(
      (event) =>
        ACTIVITY_EVENT_ACTIONS_BY_TYPE[event.target_type].indexOf(
          event.action
        ) === -1
    );
    if (invalidEvent) {
      throw new Error(
        `Invalid event action ${invalidEvent.action} for target type ${invalidEvent.target_type}`
      );
    }
  }
}

export const activityRecorder = new ActivityRecorder(dbSupplier);
