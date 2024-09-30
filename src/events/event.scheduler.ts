import { eventsDb, EventsDb, NewBulkEvent, NewEvent } from './events.db';
import { ConnectionWrapper } from '../sql-executor';
import { ProfileCicRatedEventData } from './datatypes/profile-cic-rated.event-data';
import { EventStatus, EventType } from '../entities/IEvent';
import { ProfileRepRatedEventData } from './datatypes/profile-rep-rated.event-data';
import { Time } from '../time';

export class EventScheduler {
  constructor(private readonly eventsDb: EventsDb) {}

  async scheduleCicRatingChangedEvent(
    data: ProfileCicRatedEventData,
    connection: ConnectionWrapper<any>
  ) {
    await this.schedule(
      { type: EventType.PROFILE_CIC_RATE, data: JSON.stringify(data) },
      connection
    );
  }

  async scheduleRepRatingChangedEvent(
    data: ProfileRepRatedEventData,
    connection: ConnectionWrapper<any>
  ) {
    await this.schedule(
      { type: EventType.PROFILE_REP_RATE, data: JSON.stringify(data) },
      connection
    );
  }

  async scheduleBulkRepRatingChangedEvents(
    data: ProfileRepRatedEventData[],
    connection: ConnectionWrapper<any>
  ) {
    const now = Time.now().toMillis();
    await this.scheduleBulk(
      data.map<NewBulkEvent>((d) => ({
        type: EventType.PROFILE_REP_RATE,
        status: EventStatus.NEW,
        created_at: now,
        processed_at: null,
        data: JSON.stringify(d)
      })),
      connection
    );
  }

  private async schedule(event: NewEvent, connection: ConnectionWrapper<any>) {
    await this.eventsDb.insertNewEvent(event, connection);
  }

  private async scheduleBulk(
    events: NewBulkEvent[],
    connection: ConnectionWrapper<any>
  ) {
    await this.eventsDb.insertBulk(events, connection);
  }
}

export const eventScheduler = new EventScheduler(eventsDb);
