import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { EventStatus, EventType, ProcessableEvent } from '../entities/IEvent';
import { EVENTS_TABLE, LISTENER_PROCESSED_EVENTS_TABLE } from '@/constants';
import { Time } from '../time';

const mysql = require('mysql');

export class EventsDb extends LazyDbAccessCompatibleService {
  async getListenerKeysAlreadyProcessedByEventIds(
    eventIds: number[],
    connection: ConnectionWrapper<any>
  ): Promise<Record<number, string[]>> {
    const result: { event_id: number; listener_key: string }[] =
      await this.db.execute(
        `
        select event_id, listener_key from ${LISTENER_PROCESSED_EVENTS_TABLE}
        where event_id in (:eventIds)
    `,
        { eventIds },
        { wrappedConnection: connection }
      );
    return result.reduce(
      (acc, it) => {
        acc[it.event_id] = [...(acc[it.event_id] ?? []), it.listener_key];
        return acc;
      },
      {} as Record<number, string[]>
    );
  }

  async markEventsDoneForListener(
    event_ids: number[],
    listener_key: string,
    connection: ConnectionWrapper<any>
  ) {
    for (const event_id of event_ids) {
      await this.db.execute(
        `
        insert into ${LISTENER_PROCESSED_EVENTS_TABLE} (event_id, listener_key) values (:event_id, :listener_key)
    `,
        { event_id, listener_key },
        { wrappedConnection: connection }
      );
    }
  }

  async insertNewEvent(event: NewEvent, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `
        insert into ${EVENTS_TABLE} (type, data, status, created_at)
        values (:type, :data, :status, :created_at)
    `,
      { ...event, status: EventStatus.NEW, created_at: Time.now().toMillis() },
      { wrappedConnection: connection }
    );
  }

  async lockNewEvents(
    numberOfEventsToLock: number,
    eventTypes: EventType[],
    connection: ConnectionWrapper<any>
  ): Promise<ProcessableEvent[]> {
    if (numberOfEventsToLock === 0 || eventTypes.length === 0) {
      return [];
    }
    return await this.db.execute(
      `
          select * from ${EVENTS_TABLE}
          where type in (:eventTypes) and status = '${EventStatus.NEW}'
          order by created_at asc
          limit :numberOfEventsToLock
          for update skip locked
      `,
      { numberOfEventsToLock, eventTypes },
      { wrappedConnection: connection }
    );
  }

  async markEventsAsProcessed(
    events: ProcessableEvent[],
    connection: ConnectionWrapper<any>
  ) {
    if (!events.length) {
      return;
    }
    await this.db.execute(
      `
        update ${EVENTS_TABLE} set status = '${EventStatus.PROCESSED}', processed_at = :processed_at where id in (:ids)
    `,
      { ids: events.map((it) => it.id), processed_at: Time.now().toMillis() },
      { wrappedConnection: connection }
    );
  }

  async insertBulk(events: NewBulkEvent[], connection: ConnectionWrapper<any>) {
    if (!events.length) {
      return;
    }
    const sql = `
        insert into ${EVENTS_TABLE} (
            type,
            data,
            status,
            created_at
        ) values ${events
          .map(
            (event) =>
              `(${[event.type, event.data, event.status, event.created_at]
                .map(mysql.escape)
                .join(', ')})`
          )
          .join(', ')}
    `;
    await this.db.execute(sql, undefined, { wrappedConnection: connection });
  }
}

export type NewEvent = Omit<
  ProcessableEvent,
  'id' | 'status' | 'processed_at' | 'created_at'
>;

export type NewBulkEvent = Omit<ProcessableEvent, 'id'>;

export const eventsDb = new EventsDb(dbSupplier);
