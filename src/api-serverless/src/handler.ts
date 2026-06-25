import { app, ensureInitialized } from './app';
import * as sentryContext from '../../sentry.context';
import type {
  APIGatewayEvent,
  APIGatewayProxyResult,
  Context
} from 'aws-lambda';
import {
  appWebSockets,
  authenticateWebSocketJwtOrGetByConnectionId,
  authenticateWebSocketToken
} from './ws/ws';
import { Logger } from '../../logging';
import { WsMessageType } from './ws/ws-message';
import { ids } from '../../ids';
import { wsListenersNotifier } from './ws/ws-listeners-notifier';
import { redactWebSocketMessageForLog } from './ws/ws-log-redaction';

const serverlessHttp = require('serverless-http');
const logger = Logger.get('API_HANDLER');
const SET_COOKIE_HEADER = 'set-cookie';
const COOKIE_PATH_ATTRIBUTE = 'path';
const COOKIE_DOMAIN_ATTRIBUTE = 'domain';

type LambdaHttpResponse = APIGatewayProxyResult & {
  readonly cookies?: string[];
};
type HeaderMap = Record<string, unknown>;
type SetCookieIdentity = {
  readonly name: string;
  readonly path: string;
  readonly domain: string;
};

const httpHandler = serverlessHttp(app);
export const handler = sentryContext.wrapLambdaHandler(
  async (
    event: APIGatewayEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    const path = (event as any).rawPath ?? event.path ?? 'n/a';
    const method = event.httpMethod ?? 'n/a';
    logger.info(
      `[HTTP_ENTRY] [METHOD ${method}] [PATH ${path}] [REQUEST_ID ${
        event.requestContext?.requestId ?? context.awsRequestId
      }]`
    );

    await ensureInitialized();

    logger.info(
      `[HTTP_READY] [METHOD ${method}] [PATH ${path}] [REQUEST_ID ${
        event.requestContext?.requestId ?? context.awsRequestId
      }]`
    );

    if (event.requestContext && event.requestContext.routeKey) {
      return wsHandler(event);
    } else {
      return normalizeSetCookieResponse(await httpHandler(event, context));
    }
  }
);

function normalizeSetCookieResponse(
  response: LambdaHttpResponse
): LambdaHttpResponse {
  const setCookieValues = getSetCookieValues(response);
  if (!setCookieValues.length) {
    return response;
  }

  return {
    ...response,
    headers: removeSetCookieHeaders(response.headers),
    // API Gateway REST reads multiValueHeaders; HTTP API v2 reads cookies.
    // Emitting both keeps the response valid across either integration shape.
    multiValueHeaders: {
      ...removeSetCookieHeaders(response.multiValueHeaders),
      'Set-Cookie': setCookieValues
    },
    cookies: setCookieValues
  };
}

function getSetCookieValues(response: LambdaHttpResponse): string[] {
  const values = [
    ...getHeaderValues(response.headers),
    ...getHeaderValues(response.multiValueHeaders),
    ...(response.cookies ?? [])
  ];
  return dedupeSetCookiesByIdentity(values);
}

function getHeaderValues(headers: HeaderMap | undefined): string[] {
  return Object.entries(headers ?? {}).flatMap(([key, value]) =>
    key.toLowerCase() === SET_COOKIE_HEADER ? getStringValues(value) : []
  );
}

function getStringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(getStringValues);
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [value.toString()];
  }
  return [];
}

function dedupeSetCookiesByIdentity(values: string[]): string[] {
  const indexesByIdentity = new Map<string, number>();
  const dedupedValues: string[] = [];
  values.forEach((value) => {
    const identity = serializeSetCookieIdentity(getSetCookieIdentity(value));
    const existingIndex = indexesByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexesByIdentity.set(identity, dedupedValues.length);
      dedupedValues.push(value);
      return;
    }
    dedupedValues[existingIndex] = value;
  });
  return dedupedValues;
}

function serializeSetCookieIdentity(identity: SetCookieIdentity): string {
  return `${identity.name};domain=${identity.domain};path=${identity.path}`;
}

function getSetCookieIdentity(value: string): SetCookieIdentity {
  const [nameValue = '', ...attributes] = value.split(';');
  const [name = ''] = nameValue.split('=');
  return attributes.reduce<SetCookieIdentity>(
    (identity, attribute) => {
      const [rawAttributeName = '', ...rawAttributeValueParts] =
        attribute.split('=');
      const attributeName = rawAttributeName.trim().toLowerCase();
      const attributeValue = rawAttributeValueParts.join('=').trim();
      if (attributeName === COOKIE_PATH_ATTRIBUTE) {
        return { ...identity, path: attributeValue };
      }
      if (attributeName === COOKIE_DOMAIN_ATTRIBUTE) {
        return { ...identity, domain: attributeValue.toLowerCase() };
      }
      return identity;
    },
    {
      name: name.trim(),
      path: '',
      domain: ''
    }
  );
}

function removeSetCookieHeaders<T extends HeaderMap | undefined>(
  headers: T
): T {
  if (!headers) {
    return headers;
  }
  return Object.entries(headers).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      if (key.toLowerCase() !== SET_COOKIE_HEADER) {
        acc[key] = value;
      }
      return acc;
    },
    {}
  ) as T;
}

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
        const logSafeMessage = redactWebSocketMessageForLog(message);
        wsHandlerLogger.info(
          `WS $default. Identity: ${identityId}. Message: ${JSON.stringify(
            logSafeMessage
          )}`
        );
        switch (message.type) {
          case WsMessageType.AUTHENTICATE: {
            const accessToken = (
              message.access_token ?? message.token
            )?.toString();
            const authenticated = accessToken
              ? await authenticateWebSocketToken(accessToken)
              : null;
            if (!authenticated) {
              await appWebSockets.send({
                connectionId: connectionId!,
                message: JSON.stringify({
                  type: WsMessageType.AUTHENTICATION_FAILED
                }),
                skipStaleConnectionCheck: true
              });
              return {
                statusCode: 401,
                body: JSON.stringify({ message: 'Authentication failed' })
              };
            }
            await appWebSockets.authenticateConnection(
              {
                connectionId: connectionId!,
                identityId: authenticated.identityId,
                jwtExpiry: authenticated.jwtExpiry
              },
              {}
            );
            await appWebSockets.send({
              connectionId: connectionId!,
              message: JSON.stringify({
                type: WsMessageType.AUTHENTICATED,
                identity_id: authenticated.identityId,
                expires_at: new Date(
                  authenticated.jwtExpiry * 1000
                ).toISOString()
              }),
              skipStaleConnectionCheck: true
            });
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'OK' })
            };
          }
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
