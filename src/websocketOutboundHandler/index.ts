import type { SQSHandler } from 'aws-lambda';
import { appWebSockets } from '@/api/ws/ws';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { wrapLambdaHandler } from '@/sentry.context';
import { processWebSocketBatch } from './processor';
import { deferWebSocketRetry } from './retry';

const logger = Logger.get('WEBSOCKET_OUTBOUND');
const consume: SQSHandler = async (event) =>
  doInDbContext(
    () =>
      processWebSocketBatch(
        event,
        (frame) => appWebSockets.deliverQueued(frame),
        () => {
          logger.error({ code: 'WS_OUTBOUND_RETRY_PENDING' });
        },
        deferWebSocketRetry
      ),
    { logger }
  );
export const handler = wrapLambdaHandler(consume);
