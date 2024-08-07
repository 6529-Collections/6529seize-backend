import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { ListenerProcessedEvent, ProcessableEvent } from '../entities/IEvent';
import { EventProcessor } from '../events/event.processor';
import { eventsDb } from '../events/events.db';
import { cicSumEventListener } from './eventlisteners/cic-sum.event-listener';
import { CicScoreAggregation } from '../entities/ICicScoreAggregation';
import { ProfileTotalRepScoreAggregation } from '../entities/IRepScoreAggregations';
import { profileRepSumEventListener } from './eventlisteners/profile-rep-sum.event-listener';
import { doInDbContext } from '../secrets';

const logger = Logger.get('RATE_EVENT_PROCESSING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const eventProcessor = new EventProcessor(eventsDb, [
        cicSumEventListener,
        profileRepSumEventListener
      ]);
      await eventProcessor.processUntilNoMoreEventsFound();
    },
    {
      logger,
      entities: [
        ProcessableEvent,
        CicScoreAggregation,
        ProfileTotalRepScoreAggregation,
        ListenerProcessedEvent
      ]
    }
  );
});
