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
    message
  }: {
    connectionId: string;
    message: string;
  }) {
    const entity = await this.wsConnectionRepository.getByConnectionId(
      connectionId,
      {}
    );
    if (!entity || Time.seconds(entity.jwt_expiry).lt(Time.now())) {
      this.logger.info(
        `Discovered a stale websocket ${connectionId}. Can't send messages to it. Will close it.`
      );
      await this.deregister({ connectionId });
      return;
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
}

export const ANON_USER_ID = '$ANONONYMOUS_USER$';

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
      if (connection?.identity_id) {
        return {
          identityId: connection.identity_id,
          jwtExpiry: connection.jwt_expiry
        };
      }
    }
  }
  let token: string | undefined;
  if (authorizationHeader?.startsWith('Bearer ')) {
    token = authorizationHeader.substring('Bearer '.length);
  } else {
    token = event.queryStringParameters?.token;
  }

  if (!token) {
    return {
      identityId: ANON_USER_ID,
      jwtExpiry: Time.now().plusDays(1).toMillis()
    };
  }

  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = {};
  return new Promise((resolve) => {
    passport.authenticate(
      ['jwt', 'anonymous'],
      { session: false },
      (err: any, user: any) => {
        if (err) {
          return resolve({
            identityId: ANON_USER_ID,
            jwtExpiry: Time.now().plusDays(1).toMillis()
          });
        }
        if (!user) {
          return resolve({
            identityId: ANON_USER_ID,
            jwtExpiry: Time.now().plusDays(1).toMillis()
          });
        }
        return identityFetcher
          .getProfileIdByIdentityKey({ identityKey: user.wallet }, {})
          .then((it) =>
            resolve({
              identityId: it ?? ANON_USER_ID,
              jwtExpiry: user.exp ?? Time.now().plusDays(1).toMillis()
            })
          );
      }
    )(req, res, () => {
      return resolve({
        identityId: ANON_USER_ID,
        jwtExpiry: Time.now().plusDays(1).toMillis()
      });
    });
  });
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
