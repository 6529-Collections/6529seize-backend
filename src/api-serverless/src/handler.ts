import { app, ensureInitialized } from './app';
import * as sentryContext from '../../sentry.context';
import type {
  APIGatewayEvent,
  APIGatewayProxyResult,
  Context
} from 'aws-lambda';
import {
  appWebSockets,
  authenticateWebSocketJwtOrGetByConnectionId
} from './ws/ws';
import { Logger } from '../../logging';
import { WsMessageType } from './ws/ws-message';
import { ids } from '../../ids';
import { wsListenersNotifier } from './ws/ws-listeners-notifier';

const serverlessHttp = require('serverless-http');

const httpHandler = serverlessHttp(app);
export const handler = sentryContext.wrapLambdaHandler(
  async (
    event: APIGatewayEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    await ensureInitialized();
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
  const { identityId, jwtExpiry } =
    await authenticateWebSocketJwtOrGetByConnectionId(event);
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
      try {
        const message = JSON.parse(event.body || '{}');
        wsHandlerLogger.info(
          `WS $default. Identity: ${identityId}. Message: ${JSON.stringify(
            message
          )}`
        );
        switch (message.type) {
          case WsMessageType.SUBSCRIBE_TO_WAVE: {
            const waveId = message.wave_id?.toString() ?? null;
            if (waveId && !ids.isValidUuid(waveId)) {
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid wave id' })
              };
            }
            await appWebSockets.updateActiveWaveForConnection(
              {
                connectionId: connectionId!,
                activeWaveId: waveId
              },
              {}
            );
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'OK' })
            };
          }
          case WsMessageType.USER_IS_TYPING: {
            const waveId = message.wave_id?.toString();
            if (!waveId || !ids.isValidUuid(waveId)) {
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid wave id' })
              };
            } else {
              await wsListenersNotifier.notifyAboutUserIsTyping({
                identityId,
                waveId
              });
            }
            break;
          }
          default:
            return {
              statusCode: 400,
              body: JSON.stringify({ message: 'Unrecognized action' })
            };
        }
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify({ message: 'Failed to process message' })
        };
      }
      return { statusCode: 400, body: 'This websocket does not accept data' };
    default:
      return { statusCode: 400, body: 'Unknown routeKey' };
  }
}
