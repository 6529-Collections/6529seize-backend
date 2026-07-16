import { Logger } from '../../../logging';
import * as process from 'node:process';
import WebSocket from 'ws';
import type { APIGatewayEvent } from 'aws-lambda';
import * as passport from 'passport';
import {
  wsConnectionRepository,
  WsConnectionRepository
} from './ws-connection.repository';
import { Time } from '../../../time';
import type { IncomingMessage } from 'node:http';
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand
} from '@aws-sdk/client-apigatewaymanagementapi';
import { RequestContext } from '../../../request.context';
import { identityFetcher } from '../identities/identity.fetcher';
import { isLegacyWsQueryTokenEnabled } from '../auth/auth-session-v2';

export class SocketNotAvailableException extends Error {
  constructor() {
    super(`Socket is not available`);
  }
}

abstract class ClientConnections {
  private static instance: ClientConnections | null = null;

  static Get(): ClientConnections {
    if (ClientConnections.instance) {
      return ClientConnections.instance;
    }
    ClientConnections.instance = isDevEnv()
      ? new WebsocketClientConnections()
      : new ApiGatewayClientConnections();
    return ClientConnections.instance;
  }

  abstract sendMessage({
    connectionId,
    message
  }: {
    connectionId: string;
    message: string;
  }): Promise<void>;
  abstract closeClient(connectionId: string): Promise<void>;
}

class WebsocketClientConnections extends ClientConnections {
  private readonly logger = Logger.get(WebsocketClientConnections.name);
  private readonly sockets: Record<string, WebSocket> = {};

  override async sendMessage({
    connectionId,
    message
  }: {
    connectionId: string;
    message: string;
  }) {
    const socket = this.sockets[connectionId];
    if (!socket) {
      throw new SocketNotAvailableException();
    }
    try {
      socket.send(message);
    } catch (err: any) {
      throw new SocketNotAvailableException();
    }
  }

  override async closeClient(connectionId: string): Promise<void> {
    const socket = this.sockets[connectionId];
    if (!socket) {
      return;
    }
    try {
      socket.close();
    } catch (err: any) {
      this.logger.warn(
        `Failed to close connection ${connectionId}: ${JSON.stringify(err)}`
      );
    }
    delete this.sockets[connectionId];
  }

  addSocket(connectionId: string, socket: WebSocket) {
    this.sockets[connectionId] = socket;
  }
}

class ApiGatewayClientConnections extends ClientConnections {
  private readonly logger = Logger.get(ApiGatewayManagementApiClient.name);

  private readonly client: ApiGatewayManagementApiClient;

  constructor() {
    super();
    this.client = new ApiGatewayManagementApiClient({
      endpoint: process.env.API_GATEWAY_WS_ENDPOINT
    });
  }

  override async sendMessage({
    connectionId,
    message
  }: {
    connectionId: string;
    message: string;
  }) {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(message)
        })
      );
    } catch (err: any) {
      const isInvalidConnectionId =
        err.name === 'BadRequestException' &&
        typeof err.message === 'string' &&
        err.message.includes('Invalid connectionId');
      if (
        err.name === 'GoneException' ||
        isInvalidConnectionId ||
        err.$metadata?.httpStatusCode === 410
      ) {
        throw new SocketNotAvailableException();
      } else {
        this.logger.error(
          `Failed to post message to client ${connectionId}: ${JSON.stringify(
            err
          )}`
        );
      }
    }
  }

  override async closeClient(connectionId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteConnectionCommand({
          ConnectionId: connectionId
        })
      );
    } catch (err: any) {
      // ignore
    }
  }
}

export class AppWebSockets {
  private readonly logger = Logger.get(AppWebSockets.name);

  constructor(
    private readonly wsConnectionRepository: WsConnectionRepository
  ) {}

  async send({
    connectionId,
    message,
    skipStaleConnectionCheck = false
  }: {
    connectionId: string;
    message: string;
    skipStaleConnectionCheck?: boolean;
  }) {
    if (!skipStaleConnectionCheck) {
      const entity = await this.wsConnectionRepository.getByConnectionId(
        connectionId,
        {}
      );
      const jwtExpiry = getActiveJwtExpiry(entity?.jwt_expiry);
      if (!entity || jwtExpiry === null) {
        this.logger.info(
          `Discovered a stale websocket ${connectionId}. Can't send messages to it. Will close it.`
        );
        await this.deregister({ connectionId });
        return;
      }
    }
    try {
      await ClientConnections.Get().sendMessage({ connectionId, message });
    } catch (err) {
      await this.deregister({ connectionId });
    }
  }

  async register({
    identityId,
    connectionId,
    jwtExpiry,
    ws
  }: {
    identityId: string;
    connectionId: string;
    jwtExpiry: number;
    ws?: WebSocket;
  }) {
    this.logger.info(
      `Registering socket for client ${identityId} (connectionId: ${connectionId})`
    );
    if (isDevEnv()) {
      if (!ws) {
        throw new Error('Websocket is required in dec env');
      }
      (ClientConnections.Get() as WebsocketClientConnections).addSocket(
        connectionId,
        ws
      );
    }
    await this.wsConnectionRepository.save(
      {
        identity_id: identityId,
        jwt_expiry: jwtExpiry,
        connection_id: connectionId,
        wave_id: null
      },
      {}
    );
    await this.wsConnectionRepository.replaceNotificationSubscriptions(
      connectionId,
      getAuthenticatedNotificationSubscriptions([{ identityId, jwtExpiry }]),
      {}
    );
  }

  async deregister({ connectionId }: { connectionId: string }) {
    this.logger.info(`Deregistering socket for connection ${connectionId}`);
    await ClientConnections.Get().closeClient(connectionId);
    await this.wsConnectionRepository.deleteByConnectionId(connectionId, {});
  }

  async updateActiveWaveForConnection(
    {
      connectionId,
      activeWaveId
    }: {
      connectionId: string;
      activeWaveId: string | null;
    },
    ctx: RequestContext
  ) {
    await this.wsConnectionRepository.updateWaveId(
      {
        connectionId,
        waveId: activeWaveId
      },
      ctx
    );
  }

  async authenticateConnection(
    {
      connectionId,
      identityId,
      jwtExpiry
    }: {
      connectionId: string;
      identityId: string;
      jwtExpiry: number;
    },
    ctx: RequestContext
  ) {
    await this.wsConnectionRepository.updateIdentityForConnection(
      {
        connectionId,
        identityId,
        jwtExpiry
      },
      ctx
    );
    await this.wsConnectionRepository.replaceNotificationSubscriptions(
      connectionId,
      getAuthenticatedNotificationSubscriptions([{ identityId, jwtExpiry }]),
      ctx
    );
  }

  async syncNotificationIdentities(
    connectionId: string,
    subscriptions: AuthenticatedWebSocketIdentity[],
    ctx: RequestContext
  ): Promise<string[]> {
    const authenticatedSubscriptions =
      getAuthenticatedNotificationSubscriptions(subscriptions);
    await this.wsConnectionRepository.replaceNotificationSubscriptions(
      connectionId,
      authenticatedSubscriptions,
      ctx
    );
    return authenticatedSubscriptions.map(({ identityId }) => identityId);
  }
}

export const ANON_USER_ID = '$ANONONYMOUS_USER$';
export const MAX_NOTIFICATION_IDENTITY_SUBSCRIPTIONS = 5;

export interface AuthenticatedWebSocketIdentity {
  identityId: string;
  jwtExpiry: number;
}

export async function authenticateNotificationIdentityTokens(
  value: unknown
): Promise<AuthenticatedWebSocketIdentity[] | null> {
  if (
    !Array.isArray(value) ||
    value.length > MAX_NOTIFICATION_IDENTITY_SUBSCRIPTIONS ||
    value.some((token) => typeof token !== 'string' || !token.trim())
  ) {
    return null;
  }
  const authenticated = await Promise.all(
    Array.from(new Set(value)).map((token) =>
      authenticateWebSocketToken(token as string)
    )
  );
  return getAuthenticatedNotificationSubscriptions(
    authenticated.filter(
      (result): result is AuthenticatedWebSocketIdentity => result !== null
    )
  );
}

function getAuthenticatedNotificationSubscriptions(
  subscriptions: AuthenticatedWebSocketIdentity[]
): AuthenticatedWebSocketIdentity[] {
  const byIdentityId = new Map<string, AuthenticatedWebSocketIdentity>();
  for (const subscription of subscriptions) {
    if (
      !subscription.identityId ||
      subscription.identityId === ANON_USER_ID ||
      !Number.isFinite(subscription.jwtExpiry)
    ) {
      continue;
    }
    const existing = byIdentityId.get(subscription.identityId);
    if (!existing || existing.jwtExpiry < subscription.jwtExpiry) {
      byIdentityId.set(subscription.identityId, subscription);
    }
  }
  return Array.from(byIdentityId.values());
}

export async function authenticateWebSocketJwtOrGetByConnectionId(
  event: APIGatewayEvent
): Promise<{ identityId: string; jwtExpiry: number }> {
  const authorizationHeader =
    event.headers?.Authorization || event.headers?.authorization;
  if (!authorizationHeader) {
    const connectionId = event.requestContext.connectionId;
    if (connectionId) {
      const connection = await wsConnectionRepository.getByConnectionId(
        connectionId,
        {}
      );
      const jwtExpiry = getActiveJwtExpiry(connection?.jwt_expiry);
      if (connection?.identity_id && jwtExpiry !== null) {
        return {
          identityId: connection.identity_id,
          jwtExpiry
        };
      }
      if (connection?.identity_id) {
        Logger.get('WEBSOCKET_AUTH').info(
          `Rejecting expired websocket auth for connection ${connectionId}`
        );
        await appWebSockets.deregister({ connectionId });
      }
    }
  }
  let token: string | undefined;
  if (authorizationHeader?.startsWith('Bearer ')) {
    token = authorizationHeader.substring('Bearer '.length);
  } else if (isLegacyWsQueryTokenEnabled()) {
    token = event.queryStringParameters?.token;
  }

  if (!token) {
    return {
      identityId: ANON_USER_ID,
      jwtExpiry: Time.now().plusDays(1).toSeconds()
    };
  }

  const authenticated = await authenticateWebSocketToken(token);
  return (
    authenticated ?? {
      identityId: ANON_USER_ID,
      jwtExpiry: Time.now().plusDays(1).toSeconds()
    }
  );
}

export async function authenticateWebSocketToken(
  token: string
): Promise<{ identityId: string; jwtExpiry: number } | null> {
  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = {};
  return new Promise((resolve) => {
    passport.authenticate('jwt', { session: false }, (err: any, user: any) => {
      if (err) {
        return resolve(null);
      }
      if (!user) {
        return resolve(null);
      }
      const jwtExpiry = getFiniteJwtExpiry(user.exp);
      if (jwtExpiry === null) {
        return resolve(null);
      }
      return identityFetcher
        .getProfileIdByIdentityKey({ identityKey: user.wallet }, {})
        .then((it) =>
          resolve({
            identityId: it ?? ANON_USER_ID,
            jwtExpiry
          })
        )
        .catch(() => resolve(null));
    })(req, res, () => {
      return resolve(null);
    });
  });
}

function getFiniteJwtExpiry(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function getActiveJwtExpiry(value: unknown): number | null {
  let jwtExpiry: number | null = null;
  if (typeof value === 'number') {
    jwtExpiry = value;
  } else if (typeof value === 'string') {
    jwtExpiry = Number(value);
  }
  if (jwtExpiry === null || !Number.isFinite(jwtExpiry)) {
    return null;
  }
  if (!Time.seconds(jwtExpiry).gt(Time.now())) {
    return null;
  }
  return jwtExpiry;
}

// mean only for dev environment
export function mapHttpRequestToGatewayEvent(
  req: IncomingMessage,
  connectionId: string,
  routeKey: string
): APIGatewayEvent {
  const parsedUrl = new URL(
    req.url ?? '',
    `http://${req.headers.host ?? 'localhost'}`
  );
  const queryStringParameters: Record<string, string> = {};
  parsedUrl.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
  });

  return {
    body: null,
    headers: req.headers as Record<string, string>,
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: parsedUrl.pathname,
    queryStringParameters,

    requestContext: {
      routeKey,
      connectionId,
      accountId: 'localAccountId',
      apiId: 'localApiId',
      authorizer: undefined,
      httpMethod: 'GET',
      identity: undefined,
      path: parsedUrl.pathname,
      stage: 'local',
      requestId: 'localRequestId',
      requestTimeEpoch: Date.now(),
      resourceId: 'localResourceId',
      resourcePath: parsedUrl.pathname
    },
    resource: '',
    stageVariables: undefined
  } as unknown as APIGatewayEvent;
}

function isDevEnv(): boolean {
  return process.env.NODE_ENV === 'local';
}

export const appWebSockets = new AppWebSockets(wsConnectionRepository);
