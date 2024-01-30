import { EventProcessor } from './event.processor';
import { EventsDb } from './events.db';
import { mock, Mock } from 'ts-jest-mocker';
import {
  expectExceptionWithMessage,
  mockDbService
} from '../tests/test.helper';
import { EventListener } from './event.listener';
import { when } from 'jest-when';
import { EventStatus, EventType } from '../entities/IEvent';

describe(`EventProcessor`, () => {
  let eventProcessor: EventProcessor;
  let eventListener: Mock<EventListener>;
  let eventsDb: Mock<EventsDb>;

  beforeEach(() => {
    eventsDb = mockDbService();
    eventListener = mock<EventListener>();
    when(eventListener.uniqueKey).mockReturnValue('a_unique_key');
    when(eventListener.supports).mockReturnValue(true);
    when(eventListener.eventsFound).mockResolvedValue();
    process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP = '2';
    eventProcessor = new EventProcessor(eventsDb, [eventListener]);
  });

  it('initialisation fails if no supported listeners', async () => {
    const db: Mock<EventsDb> = mockDbService();
    const listener: Mock<EventListener> = mock<EventListener>();
    when(listener.supports).mockReturnValue(false);
    await expectExceptionWithMessage(
      () => new EventProcessor(db, [listener]),
      'No properly configured listeners given to EventProcessor, nothing to do.'
    );
  });

  it('initialisation fails if number of parallel exectuions is not configured properly', async () => {
    const db: Mock<EventsDb> = mockDbService();
    const listener: Mock<EventListener> = mock<EventListener>();
    when(listener.supports).mockReturnValue(true);
    process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP = undefined;
    await expectExceptionWithMessage(
      () => new EventProcessor(db, [listener]),
      'Environment variable NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP is not set, not a number or a negative number. It must be an integer greater than zero.'
    );
    process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP = 'not a number';
    await expectExceptionWithMessage(
      () => new EventProcessor(db, [listener]),
      'Environment variable NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP is not set, not a number or a negative number. It must be an integer greater than zero.'
    );
    process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP = '0';
    await expectExceptionWithMessage(
      () => new EventProcessor(db, [listener]),
      'Environment variable NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP is not set, not a number or a negative number. It must be an integer greater than zero.'
    );
    process.env.NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP = '-1';
    await expectExceptionWithMessage(
      () => new EventProcessor(db, [listener]),
      'Environment variable NO_OF_EVENTS_TO_LOCK_IN_ONE_LOOP is not set, not a number or a negative number. It must be an integer greater than zero.'
    );
  });

  it('no events - finishes immediately', async () => {
    when(eventsDb.lockNewEvents).mockResolvedValue([]);
    await eventProcessor.processAndReturnIfAnyWasFound();
    expect(
      eventsDb.getListenerKeysAlreadyProcessedByEventIds
    ).not.toHaveBeenCalled();
    expect(eventListener.eventsFound).not.toHaveBeenCalled();
  });

  it('events done for listeners - will not redo', async () => {
    const events = [
      {
        id: 1,
        data: '{}',
        status: EventStatus.NEW,
        type: EventType.PROFILE_CIC_RATE,
        created_at: 0,
        processed_at: null
      }
    ];
    when(eventsDb.lockNewEvents).mockResolvedValue(events);
    when(eventsDb.getListenerKeysAlreadyProcessedByEventIds).mockResolvedValue({
      1: ['a_unique_key']
    });
    await eventProcessor.processAndReturnIfAnyWasFound();
    expect(eventListener.eventsFound).not.toHaveBeenCalled();
    expect(eventsDb.markEventsAsProcessed).toHaveBeenCalledWith(events, {
      connection: {}
    });
  });

  it('events not done for listeners - will do', async () => {
    const events = [
      {
        id: 1,
        data: '{}',
        status: EventStatus.NEW,
        type: EventType.PROFILE_CIC_RATE,
        created_at: 0,
        processed_at: null
      }
    ];
    when(eventsDb.lockNewEvents).mockResolvedValue(events);
    when(eventsDb.getListenerKeysAlreadyProcessedByEventIds).mockResolvedValue(
      {}
    );
    await eventProcessor.processAndReturnIfAnyWasFound();
    expect(eventListener.eventsFound).toHaveBeenCalledWith(events, {
      connection: {}
    });
    expect(eventsDb.markEventsDoneForListener).toHaveBeenCalledWith(
      [1],
      'a_unique_key',
      {
        connection: {}
      }
    );
    expect(eventsDb.markEventsAsProcessed).toHaveBeenCalledWith(events, {
      connection: {}
    });
  });
});
