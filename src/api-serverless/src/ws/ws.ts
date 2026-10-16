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
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  webSocketDelivery,
  WebSocketDeliveryResult,
  WebSocketDeliveryDeferredError
} from '@/ws-delivery/ws-delivery';
import {
  enqueueWebSocketFrame,
  QueuedWebSocketFrame
} from '@/api/ws/ws-outbound-queue';
import {
  WebSocketSendScheduler,
  hasWebSocketSendBudget
} from '@/api/ws/ws-send-scheduler';

import {
  ANON_USER_ID,
  SocketNotAvailableException,
  DURABLE_UPDATES_CAPABILITY
} from './ws-shared';
export { ANON_USER_ID, SocketNotAvailableException } from './ws-shared';

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
    message,
    abortSignal
  }: {
    connectionId: string;
    message: string;
    abortSignal?: AbortSignal;
    recovery?: boolean;
  }): Promise<WebSocketDeliveryResult>;
  abstract closeClient(
    connectionId: string,
    propagateFailure?: boolean
  ): Promise<void>;
}

class WebsocketClientConnections extends ClientConnections {
  private readonly logger = Logger.get(WebsocketClientConnections.name);
  private readonly sockets: Record<string, WebSocket> = {};

  override async sendMessage({
    connectionId,
    message,
    abortSignal
  }: {
    connectionId: string;
    message: string;
    abortSignal?: AbortSignal;
  }) {
    abortSignal?.throwIfAborted();
    const socket = this.sockets[connectionId];
    if (!socket) {
      throw new SocketNotAvailableException();
    }
    try {
      socket.send(message);
      return { status: 'sent' as const };
    } catch {
      // Normalize local unavailable transport errors.
      throw new SocketNotAvailableException();
    }
  }

  override async closeClient(
    connectionId: string,
    propagateFailure = false
  ): Promise<void> {
    const socket = this.sockets[connectionId];
    if (!socket) {
      return;
    }
    try {
      socket.close();
    } catch (err: any) {
      if (propagateFailure) throw err;
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
  private readonly client: ApiGatewayManagementApiClient;
  private readonly scheduler = new WebSocketSendScheduler();

  constructor() {
    super();
    this.client = new ApiGatewayManagementApiClient({
      endpoint: process.env.API_GATEWAY_WS_ENDPOINT,
      retryMode: 'standard',
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 5000
      })
    });
  }

  override async sendMessage({
    connectionId,
    message,
    abortSignal,
    recovery
  }: {
    connectionId: string;
    message: string;
    abortSignal?: AbortSignal;
    recovery?: boolean;
  }): Promise<WebSocketDeliveryResult> {
    let terminalError: unknown;
    const result = await webSocketDelivery.deliver({
      connectionId,
      message,
      recovery,
      signal: abortSignal,
      close: () => this.closeClient(connectionId, true),
      send: async () => {
        let response: unknown;
        try {
          await this.scheduler.send(connectionId, async (deadlineSignal) => {
            response = await this.client.send(
              new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(message)
              }),
              {
                abortSignal: abortSignal
                  ? AbortSignal.any([deadlineSignal, abortSignal])
                  : deadlineSignal
              }
            );
          });
          return response;
        } catch (error) {
          terminalError = error;
          throw error;
        }
      }
    });
    // Durable consumers retain non-throttle failures using their existing retry contract.
    if (result.status === 'failed' && !recovery)
      throw terminalError ?? new Error('WebSocket delivery failed');
    return result;
  }

  override async closeClient(
    connectionId: string,
    propagateFailure = false
  ): Promise<void> {
    try {
      await this.client.send(
        new DeleteConnectionCommand({
          ConnectionId: connectionId
        })
      );
    } catch (error: unknown) {
      if (propagateFailure && !isAlreadyDisconnected(error)) throw error;
    }
  }
}

function isAlreadyDisconnected(error: unknown): boolean {
  try {
    if (!error || typeof error !== 'object') return false;
    const name = Reflect.get(error, 'name');
    const metadata = Reflect.get(error, '$metadata');
    return (
      name === 'GoneException' ||
      (metadata !== null &&
        typeof metadata === 'object' &&
        Reflect.get(metadata, 'httpStatusCode') === 410)
    );
  } catch {
    return false;
  }
}

export class AppWebSockets {
  private readonly logger = Logger.get(AppWebSockets.name);

  constructor(
    private readonly wsConnectionRepository: WsConnectionRepository
  ) {}

  /** Queue capable-client frames; keep legacy, local and authentication replies inline. */
  async send(input: {
    connectionId: string;
    message: string;
    skipStaleConnectionCheck?: boolean;
    abortSignal?: AbortSignal;
    outboxId?: string;
    legacyOnly?: boolean;
    deliveryCapability?: typeof DURABLE_UPDATES_CAPABILITY;
    recovery?: boolean;
  }): Promise<WebSocketDeliveryResult> {
    input.abortSignal?.throwIfAborted();
    // Authentication acknowledgements must follow the control operation inline,
    // including credential rejection when no authenticated row exists yet.
    if (isDevEnv() || input.skipStaleConnectionCheck || input.recovery)
      return this.deliver(input);
    const entity = await this.wsConnectionRepository.getByConnectionId(
      input.connectionId,
      {}
    );
    input.abortSignal?.throwIfAborted();
    const expiry = getActiveJwtExpiry(entity?.jwt_expiry);
    if (!entity || expiry === null) {
      await this.deregister({ connectionId: input.connectionId });
      return { status: 'gone' };
    }
    if (input.legacyOnly && entity.durable_updates === true)
      return { status: 'sent' };
    // New outbox jobs must never switch to direct delivery after capability loss.
    if (input.deliveryCapability && entity.durable_updates !== true) {
      this.logger.warn({ code: 'WS_OUTBOUND_SESSION_CHANGED' });
      return { status: 'gone' };
    }
    if (entity.durable_updates !== true && !input.outboxId)
      return this.deliver({ ...input, skipStaleConnectionCheck: true });
    try {
      await enqueueWebSocketFrame(
        {
          connectionId: input.connectionId,
          message: input.message,
          identityId: entity.identity_id,
          jwtExpiry: expiry,
          ...(entity.durable_updates === true
            ? { deliveryCapability: DURABLE_UPDATES_CAPABILITY }
            : {})
        },
        input.abortSignal,
        input.outboxId
      );
      return { status: 'resync_pending' };
    } catch {
      // Do not expose queue bodies/provider errors, or claim failed persistence
      // was accepted. The caller must see the failure as well as the error log.
      this.logger.error({ code: 'WS_OUTBOUND_ENQUEUE_FAILED' });
      throw new Error('WebSocket queue persistence failed');
    }
  }

  /** Worker-only transport path: it must never enqueue recursively. */
  async deliverQueued(frame: QueuedWebSocketFrame): Promise<void> {
    const entity = await this.wsConnectionRepository.getByConnectionId(
      frame.connectionId,
      {}
    );
    if (!entity || getActiveJwtExpiry(entity.jwt_expiry) === null) {
      await this.deregister({ connectionId: frame.connectionId });
      return;
    }
    if (
      (frame.deliveryCapability && entity.durable_updates !== true) ||
      entity.identity_id !== frame.identityId ||
      Number(entity.jwt_expiry) !== frame.jwtExpiry
    ) {
      this.logger.warn({ code: 'WS_OUTBOUND_SESSION_CHANGED' });
      return;
    }
    if (!(await this.canDeliverQueuedPayload(frame))) return;
    const result = await this.deliver({
      connectionId: frame.connectionId,
      message: frame.message,
      skipStaleConnectionCheck: true
    });
    if (result.status === 'resync_pending')
      throw new WebSocketDeliveryDeferredError();
  }

  /** Recheck notification subscriptions and resource access before delayed delivery. */
  private async canDeliverQueuedPayload(
    frame: QueuedWebSocketFrame
  ): Promise<boolean> {
    const payload = JSON.parse(frame.message) as {
      type?: string;
      data?: {
        profile_id?: string;
        wave_id?: string;
        wave?: { id?: string };
        attachment_id?: string;
        timestamp?: number;
      };
    };
    if (
      payload.type === 'USER_IS_TYPING' &&
      (typeof payload.data?.timestamp !== 'number' ||
        Date.now() - payload.data.timestamp > 10_000)
    )
      return false;
    let accessIdentityId = frame.identityId;
    if (
      payload.type === 'IDENTITY_NOTIFICATIONS_CHANGED' ||
      payload.type === 'DM_UNREAD_STATE_CHANGED'
    ) {
      const profileId = payload.data?.profile_id;
      if (!profileId) throw new Error('Missing notification profile');
      accessIdentityId = profileId;
      const recipients =
        await this.wsConnectionRepository.findNotificationConnectionIdsByIdentityIds(
          [profileId]
        );
      if (
        !recipients.some(
          (recipient) => recipient.connectionId === frame.connectionId
        )
      ) {
        this.logger.warn({ code: 'WS_OUTBOUND_SUBSCRIPTION_CHANGED' });
        return false;
      }
    }
    const waveId = payload.data?.wave_id ?? payload.data?.wave?.id;
    const attachmentId = payload.data?.attachment_id;
    let resource: { attachmentId: string } | { waveId: string } | null = null;
    if (attachmentId) resource = { attachmentId };
    else if (waveId) resource = { waveId };
    if (
      resource &&
      !(await this.wsConnectionRepository.canIdentityReadQueuedResource(
        accessIdentityId,
        resource
      ))
    ) {
      this.logger.warn({ code: 'WS_OUTBOUND_ACCESS_CHANGED' });
      return false;
    }
    return true;
  }

  /** Send through bounded transport; propagate non-stale failures for the caller to retry. */
  async deliver({
    connectionId,
    message,
    skipStaleConnectionCheck = false,
    abortSignal,
    recovery
  }: {
    connectionId: string;
    message: string;
    skipStaleConnectionCheck?: boolean;
    abortSignal?: AbortSignal;
    recovery?: boolean;
  }): Promise<WebSocketDeliveryResult> {
    // An expired invocation goes directly to the sender's reported deadline
    // failure; do not spend the remaining budget looking up unsendable work.
    if (!skipStaleConnectionCheck && hasWebSocketSendBudget()) {
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
        return { status: 'gone' };
      }
    }
    abortSignal?.throwIfAborted();
    try {
      const result = await ClientConnections.Get().sendMessage({
        connectionId,
        message,
        abortSignal,
        recovery
      });
      if (result.status === 'gone')
        await this.wsConnectionRepository.deleteByConnectionId(
          connectionId,
          {}
        );
      return result;
    } catch (err) {
      if (err instanceof SocketNotAvailableException) {
        await this.deregister({ connectionId });
        return { status: 'gone' };
      } else {
        throw err;
      }
    }
  }

  async register({
    identityId,
    connectionId,
    jwtExpiry,
    durableUpdates = false,
    ws
  }: {
    identityId: string;
    connectionId: string;
    jwtExpiry: number;
    durableUpdates?: boolean;
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
        wave_id: null,
        durable_updates: durableUpdates
      },
      getAuthenticatedNotificationSubscriptions([{ identityId, jwtExpiry }]),
      {}
    );
    await this.wsConnectionRepository.maybeCleanupStaleNotificationSubscriptions();
  }

  async deregister({ connectionId }: { connectionId: string }) {
    this.logger.info(`Deregistering socket for connection ${connectionId}`);
    await ClientConnections.Get().closeClient(connectionId);
    await this.wsConnectionRepository.deleteByConnectionId(connectionId, {});
  }

  /** Request transport closure before cleaning legacy orphan grants. Unlike
   * best-effort deregistration, unexpected close/cleanup failures reach the caller. */
  async closeUnavailableConnection(connectionId: string): Promise<void> {
    await ClientConnections.Get().closeClient(connectionId, true);
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
      getAuthenticatedNotificationSubscriptions([{ identityId, jwtExpiry }]),
      ctx
    );
    await this.wsConnectionRepository.maybeCleanupStaleNotificationSubscriptions();
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
    await this.wsConnectionRepository.maybeCleanupStaleNotificationSubscriptions();
    return authenticatedSubscriptions.map(({ identityId }) => identityId);
  }
}

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
    value.some((token) => typeof token !== 'string' || !token.trim())
  ) {
    return null;
  }
  const uniqueTokens = Array.from(new Set(value));
  if (uniqueTokens.length > MAX_NOTIFICATION_IDENTITY_SUBSCRIPTIONS) {
    return null;
  }
  const authenticated = await Promise.all(
    uniqueTokens.map((token) => authenticateWebSocketToken(token as string))
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
