import { EventsDb } from './events.db';
import { EventType, ProcessableEvent } from '../entities/IEvent';
import { EventListener } from './event.listener';
import { Logger } from '../logging';
import { distinct } from '../helpers';
import { ConnectionWrapper } from '../sql-executor';

export class EventProcessor {
  private readonly logger = Logger.get('EVENT_PROCESSOR');
  private readonly supportedTypes: EventType[];
  private readonly numberOfEventsToLockInOneLoop: number;

  constructor(
    private readonly eventsDb: EventsDb,
    private readonly listeners: EventListener[]
  ) {
    this.supportedTypes = distinct(
      Object.values(EventType).filter((type) =>
        listeners.find((l) => l.supports(type))
      )
    );
    if (this.supportedTypes.length === 0) {
      throw new Error(
        'No properly configured listeners given to EventProcessor, nothing to do.'
      );
    }
    this.numberOfEventsToLockInOneLoop = parseInt(
      process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP ?? ''
    );
    if (
      isNaN(this.numberOfEventsToLockInOneLoop) ||
      this.numberOfEventsToLockInOneLoop <= 0
    ) {
      throw new Error(
        'Environment variable NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP is not set, not a number or a negative number. It must be an integer greater than zero.'
      );
    }
  }

  async processUntilNoMoreEventsFound() {
    let foundEvents = true;
    do {
      foundEvents = await this.processAndReturnIfAnyWasFound();
    } while (foundEvents);
  }

  async processAndReturnIfAnyWasFound(): Promise<boolean> {
    return await this.eventsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const events = await this.eventsDb.lockNewEvents(
          this.numberOfEventsToLockInOneLoop,
          this.supportedTypes,
          connection
        );
        if (events.length === 0) {
          this.logger.info(`Found no events to process`);
          return false;
        }
        this.logger.info(`Found ${events.length} event(s) to process`);
        const processedKeysByEventIds =
          await this.eventsDb.getListenerKeysAlreadyProcessedByEventIds(
            events.map((it) => it.id),
            connection
          );
        const jobs = this.listeners.map((listener) =>
          this.filterAndProcessEvents(
            listener,
            events,
            processedKeysByEventIds,
            connection
          )
        );
        await Promise.all(jobs);
        await this.eventsDb.markEventsAsProcessed(events, connection);
        return true;
      }
    );
  }

  private async filterAndProcessEvents(
    listener: EventListener,
    events: ProcessableEvent[],
    processedKeysByEventIds: Record<number, string[]>,
    connection: ConnectionWrapper<any>
  ) {
    const listenerKey = listener.uniqueKey();
    const eventsForListener = events.filter(
      (event) =>
        !processedKeysByEventIds[event.id]?.includes(listenerKey) &&
        listener.supports(event.type)
    );
    if (!eventsForListener.length) {
      return;
    }
    this.logger.info(
      `Running ${eventsForListener.length} event(s) for listener ${listenerKey}`
    );
    return listener.eventsFound(eventsForListener, connection).then(() =>
      this.eventsDb.markEventsDoneForListener(
        eventsForListener.map((it) => it.id),
        listenerKey,
        connection
      )
    );
  }
}
