import { reportWebSocketOutboxHealth } from '@/websocket-outbox/health';
import { publishWebSocketOutbox } from '@/websocket-outbox/publisher';
import { wakeWebSocketOutbox } from '@/websocket-outbox/wakeup';
import type { Handler, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { appWebSockets } from '@/api/ws/ws';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { wrapLambdaHandler } from '@/sentry.context';
import { processWebSocketBatch } from './processor';
import { deferWebSocketRetry } from './retry';

const logger = Logger.get('WEBSOCKET_OUTBOUND');
/** Consume queued frames in DB context and retain failures with randomized retry visibility. */
const consume: Handler<SQSEvent | ScheduledEvent> = async (event, context) =>
  doInDbContext(
    async () => {
      const drain = async () => {
        const published = await publishWebSocketOutbox(
          async (event, id) => {
            if (event.type !== 'delivery')
              throw new Error('Expected recipient job');
            await appWebSockets.send({
              ...event,
              outboxId: `outbox:${id}`,
              abortSignal: AbortSignal.timeout(
                Math.max(1, context.getRemainingTimeInMillis() - 3000)
              )
            });
          },
          undefined,
          () => context.getRemainingTimeInMillis() > 5000
        );
        if (published > 0) await wakeWebSocketOutbox();
      };
      if (!('Records' in event)) {
        await reportWebSocketOutboxHealth();
        return drain();
      }
      return processWebSocketBatch(
        event,
        (frame) => appWebSockets.deliverQueued(frame),
        () => {
          logger.error({ code: 'WS_OUTBOUND_RETRY_PENDING' });
        },
        deferWebSocketRetry,
        drain
      );
    },
    { logger }
  );
export const handler = wrapLambdaHandler(consume);
