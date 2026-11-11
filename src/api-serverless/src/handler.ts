import { withRequestDeadline } from '@/api/write-transaction-budget';
import type {} from '../../typeorm-index-options';
import { clientVersionFromQuery } from '@/ws-client-versions/ws-client-versions';
import { app, ensureInitialized } from './app';
import * as sentryContext from '../../sentry.context';
import type {
  APIGatewayEvent,
  APIGatewayProxyResult,
  Context
} from 'aws-lambda';
import {
  ANON_USER_ID,
  appWebSockets,
  authenticateNotificationIdentityTokens,
  authenticateWebSocketJwtOrGetByConnectionId,
  authenticateWebSocketToken,
  connectionPurposeFromQuery
} from './ws/ws';
import { pongFrame, readPingFrame, type WsPingFrame } from './ws/ws-ping';
import { Logger } from '../../logging';
import {
  notificationIdentitiesSyncedMessage,
  WsMessageType,
  WS_RECOVERY_CAPABILITY
} from './ws/ws-message';
import { ids } from '../../ids';
import { wsListenersNotifier } from './ws/ws-listeners-notifier';
import { wsFrameBudget } from '@/api/ws/ws-frame-budget';
import { wsTypingCoalescer } from '@/api/ws/ws-typing-coalescer';
import {
  isExpectedClientError,
  operationalResponse
} from '../../operational-errors';
import { ApiCompliantException } from '../../exceptions';
import {
  recoverUnavailableWebSocket,
  WebSocketControlOperation
} from '@/api/ws/ws-control-failure';
import {
  setWebSocketDiagnosticOperation,
  withWebSocketOperationDiagnostics
} from '@/api/ws/ws-operation-diagnostics';
import { withProxyPinScope } from '@/db/proxy-session-pinning';

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
  ): Promise<APIGatewayProxyResult> =>
    // DB sessions pinned by RDS Proxy during this invocation stay reusable
    // until it ends, then are destroyed so idle containers hold none.
    withProxyPinScope(() => handleInvocation(event, context))
);

async function handleInvocation(
  event: APIGatewayEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
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
    return withWebSocketOperationDiagnostics(
      {
        routeKey: event.requestContext.routeKey,
        connectionId: event.requestContext.connectionId ?? '',
        lambdaRequestId: context.awsRequestId,
        gatewayRequestId: event.requestContext.requestId
      },
      async () => operationalResponse(await wsHandler(event))
    );
  } else {
    // Write transactions end (and answer 503) before this Lambda times out.
    const remaining =
      typeof context?.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : null;
    const response = remaining
      ? await withRequestDeadline(remaining, () => httpHandler(event, context))
      : await httpHandler(event, context);
    return normalizeSetCookieResponse(event, operationalResponse(response));
  }
}

function normalizeSetCookieResponse(
  event: APIGatewayEvent,
  response: LambdaHttpResponse
): LambdaHttpResponse {
  const setCookieValues = getSetCookieValues(response);
  if (!setCookieValues.length) {
    return response;
  }

  const { cookies, headers, multiValueHeaders, ...rest } = response;
  const normalizedHeaders = removeSetCookieHeaders(headers);
  if (isHttpApiV2Event(event)) {
    return {
      ...rest,
      headers: normalizedHeaders,
      cookies: setCookieValues
    };
  }

  return {
    ...rest,
    headers: normalizedHeaders,
    multiValueHeaders: {
      ...removeSetCookieHeaders(multiValueHeaders),
      'Set-Cookie': setCookieValues
    }
  };
}

function isHttpApiV2Event(event: APIGatewayEvent): boolean {
  return (event as { readonly version?: string }).version === '2.0';
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

async function answerPing(
  ping: WsPingFrame,
  connectionId: string
): Promise<APIGatewayProxyResult> {
  if (ping.kind === 'invalid') {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid PING' })
    };
  }
  try {
    await appWebSockets.send({
      connectionId,
      message: pongFrame(ping.id),
      skipStaleConnectionCheck: true
    });
    return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
  } catch {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to process message' })
    };
  }
}

/**
 * One typing notification per identity and wave within the coalescing
 * window; repeats inside it are acknowledged without a fan-out. The window
 * stays claimed only when a notification was delivered: a refused or
 * undelivered one frees it for the next frame. Anonymous frames are never
 * coalesced, so they keep their authentication error.
 */
async function notifyTypingCoalesced(
  identityId: string,
  waveId: string
): Promise<void> {
  const coalesce = identityId !== ANON_USER_ID;
  if (coalesce && !(await wsTypingCoalescer.claim(identityId, waveId))) {
    return;
  }
  const release = async () => {
    if (!coalesce) return;
    await wsTypingCoalescer.release(identityId, waveId).catch(() => {
      // The window expires on its own.
    });
  };
  let delivered: boolean;
  try {
    delivered = await wsListenersNotifier.notifyAboutUserIsTyping({
      identityId,
      waveId
    });
  } catch (error) {
    await release();
    throw error;
  }
  if (!delivered) await release();
}

const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set(
  Object.values(WsMessageType)
);

/** The frame's type when it is one we know, for budgets and logs only. */
function inboundFrameType(body: string | null): string | null {
  try {
    const type: unknown = Reflect.get(Object(JSON.parse(body ?? '{}')), 'type');
    return typeof type === 'string' && KNOWN_FRAME_TYPES.has(type)
      ? type
      : null;
  } catch {
    return null;
  }
}

function frameBytes(body: string | null): number {
  return body ? Buffer.byteLength(body, 'utf8') : 0;
}

async function wsHandler(
  event: APIGatewayEvent
): Promise<APIGatewayProxyResult> {
  const wsHandlerLogger = Logger.get('wsHandler');
  const { routeKey, connectionId } = event.requestContext;
  let frameType: string | null = null;
  if (routeKey === '$default') {
    // Answered before authentication: no database read or write.
    const ping = readPingFrame(event.body);
    if (ping) return answerPing(ping, connectionId!);
    // Every other frame spends this connection's budget before any
    // database read; typing frames also spend a stricter one.
    frameType = inboundFrameType(event.body);
    if ((await wsFrameBudget.take(connectionId!, frameType)) === 'rejected') {
      wsHandlerLogger.info(
        `WS $default over budget. Type: ${frameType ?? 'unknown'}. Bytes: ${frameBytes(event.body)}`
      );
      return {
        statusCode: 429,
        body: JSON.stringify({ message: 'Too many messages' })
      };
    }
  }
  const { identityId, jwtExpiry, purpose } =
    await authenticateWebSocketJwtOrGetByConnectionId(event);
  switch (routeKey) {
    case '$connect':
      try {
        const clientVersion = clientVersionFromQuery(
          event.queryStringParameters
        );
        await appWebSockets.register({
          identityId,
          connectionId: connectionId!,
          jwtExpiry,
          purpose: connectionPurposeFromQuery(event.queryStringParameters),
          ...(clientVersion ? { clientVersion } : {}),
          ...(event.queryStringParameters?.recovery_capability ===
          WS_RECOVERY_CAPABILITY
            ? { recoveryCapable: true }
            : {})
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
      await appWebSockets.deregister({
        connectionId: connectionId!,
        disconnect: {
          purpose: purpose ?? null,
          authenticated: identityId !== ANON_USER_ID,
          connectedAt: event.requestContext.connectedAt
        }
      });
      return { statusCode: 200, body: 'Disconnected' };
    case '$default': {
      let isTypingMessage = false;
      let controlOperation: WebSocketControlOperation | undefined;
      try {
        const message = JSON.parse(event.body || '{}');
        setWebSocketDiagnosticOperation(message.type);
        // Type and size only: frame bodies carry tokens and user content.
        wsHandlerLogger.info(
          `WS $default. Identity: ${identityId}. Type: ${
            frameType ?? 'unknown'
          }. Bytes: ${frameBytes(event.body)}`
        );
        switch (message.type) {
          case WsMessageType.AUTHENTICATE: {
            controlOperation = WsMessageType.AUTHENTICATE;
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
          case WsMessageType.SYNC_NOTIFICATION_IDENTITIES: {
            controlOperation = WsMessageType.SYNC_NOTIFICATION_IDENTITIES;
            const subscriptions = await authenticateNotificationIdentityTokens(
              message.access_tokens
            );
            if (subscriptions === null) {
              return {
                statusCode: 400,
                body: JSON.stringify({
                  message: 'Invalid notification identity tokens'
                })
              };
            }
            const profileIds = await appWebSockets.syncNotificationIdentities(
              connectionId!,
              subscriptions,
              {}
            );
            await appWebSockets.send({
              connectionId: connectionId!,
              message: JSON.stringify(
                notificationIdentitiesSyncedMessage(profileIds)
              ),
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
          case WsMessageType.SET_OPEN_WAVE: {
            const waveId = message.wave_id?.toString() ?? null;
            if (waveId && !ids.isValidUuid(waveId)) {
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid wave id' })
              };
            }
            await appWebSockets.updateOpenWaveForConnection(
              { connectionId: connectionId!, openWaveId: waveId },
              {}
            );
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'OK' })
            };
          }
          case WsMessageType.USER_IS_TYPING: {
            isTypingMessage = true;
            const waveId = message.wave_id?.toString();
            if (!waveId || !ids.isValidUuid(waveId)) {
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Invalid wave id' })
              };
            }
            await notifyTypingCoalesced(identityId, waveId);
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'OK' })
            };
          }
          default:
            return {
              statusCode: 400,
              body: JSON.stringify({ message: 'Unrecognized action' })
            };
        }
      } catch (err) {
        if (
          await recoverUnavailableWebSocket(
            err,
            controlOperation,
            connectionId!
          )
        ) {
          return {
            statusCode: 410,
            body: JSON.stringify({
              message: 'Connection is no longer available'
            })
          };
        }
        if (isTypingMessage && isExpectedClientError(err)) {
          return {
            statusCode: (err as ApiCompliantException).getStatusCode(),
            body: JSON.stringify({ message: 'Typing update is not permitted' })
          };
        }
        return {
          statusCode: 500,
          body: JSON.stringify({ message: 'Failed to process message' })
        };
      }
    }
    default:
      return { statusCode: 400, body: 'Unknown routeKey' };
  }
}
