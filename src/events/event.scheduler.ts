import { eventsDb, EventsDb, NewEvent } from './events.db';
import { ConnectionWrapper } from '../sql-executor';
import { ProfileCicRatedEventData } from './datatypes/profile-cic-rated.event-data';
import { EventType } from '../entities/IEvent';
import { ProfileRepRatedEventData } from './datatypes/profile-rep-rated.event-data';

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

  async schedule(event: NewEvent, connection: ConnectionWrapper<any>) {
    await this.eventsDb.insertNewEvent(event, connection);
  }
}

export const eventScheduler = new EventScheduler(eventsDb);
