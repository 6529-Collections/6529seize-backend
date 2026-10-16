import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { recoverWebSocketDeliveries } from '@/ws-delivery/ws-delivery-recovery';

const logger = Logger.get('WEBSOCKET_DELIVERY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(recoverWebSocketDeliveries, { logger, entities: [] });
});
