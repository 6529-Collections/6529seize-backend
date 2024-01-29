import { EventType, ProcessableEvent } from '../entities/IEvent';
import { ConnectionWrapper } from '../sql-executor';

export interface EventListener {
  eventsFound(
    events: ProcessableEvent[],
    connection: ConnectionWrapper<any>
  ): Promise<void>;

  supports(event: EventType): boolean;

  uniqueKey(): string;
}
