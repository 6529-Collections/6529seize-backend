import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { NewActivityEvent } from './new-activity-event';
import { ACTIVITY_EVENTS_TABLE } from '@/constants';
import { Time, Timer } from '../time';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../entities/IActivityEvent';
import { RequestContext } from '../request.context';

const mysql = require('mysql');

const ACTIVITY_EVENT_ACTIONS_BY_TYPE: Record<
  ActivityEventTargetType,
  ActivityEventAction[]
> = {
  [ActivityEventTargetType.IDENTITY]: [
    ActivityEventAction.WAVE_CREATED,
    ActivityEventAction.DROP_CREATED,
    ActivityEventAction.DROP_REPLIED
  ],
  [ActivityEventTargetType.WAVE]: [ActivityEventAction.DROP_CREATED],
  [ActivityEventTargetType.DROP]: [ActivityEventAction.DROP_REPLIED]
};

export class ActivityRecorder extends LazyDbAccessCompatibleService {
  async recordDropCreated(
    {
      drop_id,
      wave_id,
      creator_id,
      visibility_group_id,
      reply_to
    }: {
      drop_id: string;
      wave_id: string;
      creator_id: string;
      visibility_group_id: string | null;
      reply_to: {
        drop_id: string;
        part_id: number;
      } | null;
    },
    connection: ConnectionWrapper<any>,
    timer?: Timer
  ) {
    timer?.start('activityRecorder->recordDropCreated');
    const events: NewActivityEvent[] = [
      {
        target_id: creator_id,
        target_type: ActivityEventTargetType.IDENTITY,
        action: ActivityEventAction.DROP_CREATED,
        data: { drop_id, wave_id },
        wave_id,
        visibility_group_id,
        action_author_id: creator_id
      }
    ];
    if (reply_to === null) {
      events.push({
        target_id: wave_id,
        target_type: ActivityEventTargetType.WAVE,
        action: ActivityEventAction.DROP_CREATED,
        data: { drop_id, creator_id },
        wave_id,
        visibility_group_id,
        action_author_id: creator_id
      });
    } else {
      events.push({
        target_id: reply_to.drop_id,
        target_type: ActivityEventTargetType.DROP,
        action: ActivityEventAction.DROP_REPLIED,
        data: {
          replier_id: creator_id,
          drop_part_id: reply_to.part_id,
          reply_id: drop_id
        },
        wave_id,
        visibility_group_id,
        action_author_id: creator_id
      });
    }
    await this.recordEvents(events, connection);
    timer?.stop('activityRecorder->recordDropCreated');
  }

  async recordWaveCreated(
    {
      wave_id,
      creator_id,
      visibility_group_id
    }: {
      wave_id: string;
      creator_id: string;
      visibility_group_id: string | null;
    },
    { timer, connection }: RequestContext
  ) {
    timer?.start('activityRecorder->recordWaveCreated');
    await this.recordEvent(
      {
        target_id: creator_id,
        target_type: ActivityEventTargetType.IDENTITY,
        action: ActivityEventAction.WAVE_CREATED,
        data: { wave_id },
        wave_id,
        visibility_group_id,
        action_author_id: creator_id
      },
      connection
    );
    timer?.stop('activityRecorder->recordWaveCreated');
  }

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
            created_at,
            wave_id,
            action_author_id
        ) values ${events
          .map(
            (event) =>
              `(${mysql.escape(event.target_id)}, ${mysql.escape(
                event.target_type
              )}, ${mysql.escape(event.action)}, ${mysql.escape(
                JSON.stringify(event.data)
              )}, ${mysql.escape(
                event.visibility_group_id
              )}, ${now}, ${mysql.escape(event.wave_id)}, ${mysql.escape(
                event.action_author_id
              )})`
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
