import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { ListenerProcessedEvent, ProcessableEvent } from '../entities/IEvent';
import { EventProcessor } from '../events/event.processor';
import { eventsDb } from '../events/events.db';
import { cicSumEventListener } from './cic-score/cic-sum.event-listener';
import { CicScoreAggregation } from '../entities/ICicScoreAggregation';

const logger = Logger.get('RATE_EVENT_PROCESSING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    ProcessableEvent,
    CicScoreAggregation,
    ListenerProcessedEvent
  ]);
  const eventProcessor = new EventProcessor(eventsDb, [cicSumEventListener]);
  await eventProcessor.processUntilNoMoreEventsFound();
  await unload();
  logger.info(`[COMPLETE]`);
});
