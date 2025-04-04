import { app } from './app';
import * as sentryContext from '../../sentry.context';
import type {
  APIGatewayEvent,
  APIGatewayProxyResult,
  Context
} from 'aws-lambda';
import { appWebSockets, authenticateWebSocketJwt } from './ws/ws';
import { Logger } from '../../logging';

const serverlessHttp = require('serverless-http');

const httpHandler = serverlessHttp(app);
export const handler = sentryContext.wrapLambdaHandler(
  async (
    event: APIGatewayEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    if (event.requestContext && event.requestContext.routeKey) {
      return wsHandler(event);
    } else {
      return httpHandler(event, context);
    }
  }
);

async function wsHandler(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const wsHandlerLogger = Logger.get('wsHandler');
  const { routeKey, connectionId } = event.requestContext;
  const { identityId, jwtExpiry } = await authenticateWebSocketJwt(event);
  switch (routeKey) {
    case '$connect':
      try {
        await appWebSockets.register({
          identityId,
          connectionId: connectionId!,
          jwtExpiry
        });
        return { statusCode: 200, body: 'Connected' };
      } catch (e) {
        wsHandlerLogger.error(
          `Failed to connect to websocket (clientId: ${identityId}) Error: ${JSON.stringify(
            e
          )}`
        );
        return { statusCode: 500, body: 'Failed to connect' };
      }
    case '$disconnect':
      await appWebSockets.deregister({ connectionId: connectionId! });
      return { statusCode: 200, body: 'Disconnected' };
    case '$default':
      return { statusCode: 400, body: 'This websocket does not accept data' };
    default:
      return { statusCode: 400, body: 'Unknown routeKey' };
  }
}
