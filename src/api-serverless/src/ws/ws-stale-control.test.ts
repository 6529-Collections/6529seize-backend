import type { APIGatewayEvent, Context } from 'aws-lambda';
import type { PoolConnection } from 'mysql';
import { DbQueryOptions } from '@/db-query.options';
import { execNativeTransactionally } from '@/db/my-sql.helpers';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import * as sockets from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { WsMessageType } from '@/api/ws/ws-message';
import { HttpResponse } from '@smithy/protocol-http';
import { withOperationalContext } from '@/operational-errors';

const mockErrors = jest.fn();
const mockWarnings = jest.fn();
const mockTransport = jest.fn();
jest.mock('serverless-http', () => jest.fn(() => jest.fn()));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: (...args: unknown[]) => mockWarnings(...args),
      debug: jest.fn(),
      error: (...args: unknown[]) => mockErrors(...args)
    })
  }
}));
jest.mock('@/api/app', () => ({
  app: {},
  ensureInitialized: async () => undefined
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {}
}));
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  const actual = jest.requireActual('@aws-sdk/client-apigatewaymanagementapi');
  return {
    ...actual,
    ApiGatewayManagementApiClient: jest.fn(function () {
      return new actual.ApiGatewayManagementApiClient({
        endpoint: 'https://synthetic.invalid',
        region: 'us-east-1',
        maxAttempts: 1,
        credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
        requestHandler: {
          handle: (...args: unknown[]) => mockTransport(...args)
        }
      });
    })
  };
});

const { handler } = require('@/api/handler') as typeof import('@/api/handler');

// Real handler, repository and transaction helper; synthetic SQL storage and
// SDK HTTP handler. This models missing-row behavior, not historical causation.
class ConnectionDatabase extends SqlExecutor {
  present = false;
  mutationWrites = 0;
  cleanupWrites = 0;
  commits = 0;
  rollbacks = 0;
  releases = 0;
  order: string[] = [];
  operationFailure: Error | undefined;
  cleanupFailure: Error | undefined;

  async execute<T>(
    sql: string,
    _params?: unknown,
    options?: DbQueryOptions
  ): Promise<T[]> {
    if (!options?.wrappedConnection)
      throw new Error('Query escaped transaction');
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select connection_id from ws_connections')) {
      this.order.push('lock');
      if (this.operationFailure) throw this.operationFailure;
      return (
        this.present ? [{ connection_id: 'synthetic-socket' }] : []
      ) as T[];
    }
    if (normalized.startsWith('delete from')) {
      this.order.push('delete');
      if (!this.present) {
        if (this.cleanupFailure) throw this.cleanupFailure;
        this.cleanupWrites++;
      } else {
        this.mutationWrites++;
      }
      return [];
    }
    if (!this.present) throw new Error('Mutation attempted without connection');
    this.mutationWrites++;
    this.order.push('write');
    return [];
  }

  async executeNativeQueriesInTransaction<T>(
    fn: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    const connection = {
      beginTransaction: jest.fn(),
      commit: (callback: (error?: Error) => void) => {
        this.commits++;
        this.order.push('commit');
        callback();
      },
      rollback: () => {
        this.rollbacks++;
        this.order.push('rollback');
      },
      release: () => {
        this.releases++;
        this.order.push('release');
      }
    };
    return execNativeTransactionally(
      fn,
      connection as unknown as PoolConnection
    );
  }
}

function response(statusCode = 204, errorType?: string) {
  return {
    response: new HttpResponse({
      statusCode,
      headers: {
        'content-type': 'application/json',
        ...(errorType ? { 'x-amzn-errortype': errorType } : {})
      },
      body: Buffer.from(
        errorType ? JSON.stringify({ message: 'PRIVATE_PROVIDER_CANARY' }) : ''
      )
    })
  };
}

function fixture(type: WsMessageType) {
  const db = new ConnectionDatabase();
  const repository = new WsConnectionRepository(
    () => db,
    {} as never,
    () => false
  );
  const realSockets = new sockets.AppWebSockets(repository);
  const identity = { identityId: 'synthetic-profile', jwtExpiry: 2000000000 };
  jest
    .spyOn(sockets, 'authenticateWebSocketJwtOrGetByConnectionId')
    .mockResolvedValue({
      identityId: sockets.ANON_USER_ID,
      jwtExpiry: 2000000000
    });
  jest.spyOn(sockets, 'authenticateWebSocketToken').mockResolvedValue(identity);
  jest
    .spyOn(sockets, 'authenticateNotificationIdentityTokens')
    .mockResolvedValue([identity]);
  jest
    .spyOn(sockets.appWebSockets, 'authenticateConnection')
    .mockImplementation(realSockets.authenticateConnection.bind(realSockets));
  jest
    .spyOn(sockets.appWebSockets, 'syncNotificationIdentities')
    .mockImplementation(
      realSockets.syncNotificationIdentities.bind(realSockets)
    );
  jest
    .spyOn(sockets.appWebSockets, 'closeUnavailableConnection')
    .mockImplementation(
      realSockets.closeUnavailableConnection.bind(realSockets)
    );
  mockTransport.mockImplementation(async (request: { method: string }) => {
    db.order.push(request.method);
    return response();
  });
  const invoke = () =>
    withOperationalContext('synthetic-request', () =>
      handler(
        {
          body: JSON.stringify({
            type,
            access_token: 'PRIVATE_TOKEN_CANARY',
            access_tokens: ['PRIVATE_TOKEN_CANARY']
          }),
          requestContext: {
            routeKey: '$default',
            connectionId: 'synthetic-socket'
          }
        } as APIGatewayEvent,
        { awsRequestId: 'synthetic-request' } as Context,
        jest.fn()
      )
    );
  return { db, invoke };
}

describe('missing stored WebSocket connection recovery', () => {
  const originalEnvironment = process.env;
  let output: jest.SpyInstance;
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'test',
      AWS_LAMBDA_FUNCTION_NAME: 'seizeAPI',
      SENTRY_ENVIRONMENT: 'api_staging'
    };
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    mockTransport.mockReset();
    mockWarnings.mockReset();
    mockErrors.mockReset();
  });
  afterEach(() => {
    expect(JSON.stringify(output.mock.calls)).not.toContain('CANARY');
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  it('preserves actual exception identity under the root and API compile targets', () => {
    expect(new sockets.SocketNotAvailableException()).toBeInstanceOf(
      sockets.SocketNotAvailableException
    );
  });

  it.each([
    WsMessageType.AUTHENTICATE,
    WsMessageType.SYNC_NOTIFICATION_IDENTITIES
  ])(
    '%s rolls back, closes the actual SDK transport, then removes only orphan state without ACK',
    async (type) => {
      const { db, invoke } = fixture(type);
      expect(await invoke()).toMatchObject({ statusCode: 410 });
      expect(db).toMatchObject({
        mutationWrites: 0,
        cleanupWrites: 2,
        commits: 1,
        rollbacks: 1,
        releases: 2
      });
      expect(db.order).toEqual([
        'lock',
        'rollback',
        'release',
        'DELETE',
        'lock',
        'delete',
        'delete',
        'commit',
        'release'
      ]);
      expect(mockTransport).toHaveBeenCalledTimes(1);
      expect(mockTransport.mock.calls[0][0]).toMatchObject({
        method: 'DELETE',
        path: '/@connections/synthetic-socket'
      });
      expect(mockErrors).not.toHaveBeenCalled();
      expect(mockWarnings).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    }
  );

  it.each([
    WsMessageType.AUTHENTICATE,
    WsMessageType.SYNC_NOTIFICATION_IDENTITIES
  ])('%s keeps commit-before-ACK for an existing row', async (type) => {
    const { db, invoke } = fixture(type);
    db.present = true;
    expect(await invoke()).toMatchObject({ statusCode: 200 });
    expect(db).toMatchObject({ commits: 1, rollbacks: 0, cleanupWrites: 0 });
    expect(db.order.indexOf('commit')).toBeLessThan(db.order.indexOf('POST'));
    expect(mockTransport.mock.calls.map(([request]) => request.method)).toEqual(
      ['POST']
    );
    expect(
      sockets.appWebSockets.closeUnavailableConnection
    ).not.toHaveBeenCalled();
  });

  it('treats an already-gone SDK DELETE as successful stale cleanup', async () => {
    const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
    mockTransport.mockResolvedValue(response(410, 'GoneException'));
    expect(await invoke()).toMatchObject({ statusCode: 410 });
    expect(db.cleanupWrites).toBe(2);
    expect(mockWarnings).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500])(
    'keeps unexpected DELETE %s as 5xx with bounded context and no false cleanup success',
    async (status) => {
      const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
      mockTransport.mockResolvedValue(
        response(
          status,
          status === 403 ? 'ForbiddenException' : 'LimitExceededException'
        )
      );
      expect(await invoke()).toMatchObject({ statusCode: 500 });
      expect(db.cleanupWrites).toBe(0);
      expect(mockTransport).toHaveBeenCalledTimes(1);
      expect(mockWarnings.mock.calls).toEqual([
        ['[WS_CONTROL_FAILED] [ACTION AUTHENTICATE] [STAGE cleanup]']
      ]);
      expect(JSON.stringify(mockErrors.mock.calls)).not.toContain('CANARY');
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
        code: 'APPLICATION_ERROR'
      });
    }
  );

  it('keeps cleanup SQL failure unexpected after requesting transport close', async () => {
    const { db, invoke } = fixture(WsMessageType.SYNC_NOTIFICATION_IDENTITIES);
    db.cleanupFailure = new Error('PRIVATE_SQL_CANARY');
    expect(await invoke()).toMatchObject({ statusCode: 500 });
    expect(db).toMatchObject({
      commits: 0,
      rollbacks: 2,
      releases: 2,
      cleanupWrites: 0,
      mutationWrites: 0
    });
    expect(mockWarnings.mock.calls).toEqual([
      [
        '[WS_CONTROL_FAILED] [ACTION SYNC_NOTIFICATION_IDENTITIES] [STAGE cleanup]'
      ]
    ]);
    expect(mockTransport.mock.calls.map(([request]) => request.method)).toEqual(
      ['DELETE']
    );
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an arbitrary Error with matching text for the typed stale condition', async () => {
    const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
    db.operationFailure = new Error('Socket is not available');
    expect(await invoke()).toMatchObject({ statusCode: 500 });
    expect(mockTransport).not.toHaveBeenCalled();
    expect(mockWarnings.mock.calls).toEqual([
      ['[WS_CONTROL_FAILED] [ACTION AUTHENTICATE] [STAGE operation]']
    ]);
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('preserves genuine credential rejection even when the stored row is absent', async () => {
    const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
    jest.mocked(sockets.authenticateWebSocketToken).mockResolvedValue(null);
    expect(await invoke()).toMatchObject({ statusCode: 401 });
    expect(db.order).toEqual(['POST']);
    expect(mockTransport.mock.calls[0][0].body.toString()).toContain(
      'AUTHENTICATION_FAILED'
    );
    expect(
      sockets.appWebSockets.closeUnavailableConnection
    ).not.toHaveBeenCalled();
  });

  it('preserves invalid SYNC input without any mutation or transport cleanup', async () => {
    const { db, invoke } = fixture(WsMessageType.SYNC_NOTIFICATION_IDENTITIES);
    jest
      .mocked(sockets.authenticateNotificationIdentityTokens)
      .mockResolvedValue(null);
    expect(await invoke()).toMatchObject({ statusCode: 400 });
    expect(db.order).toEqual([]);
    expect(mockTransport).not.toHaveBeenCalled();
  });

  it('does not let a throwing diagnostic logger change the 5xx or leak the original error', async () => {
    const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
    db.operationFailure = new Error('PRIVATE_SQL_CANARY');
    mockWarnings.mockImplementation(() => {
      throw new Error('PRIVATE_LOG_CANARY');
    });
    expect(await invoke()).toMatchObject({ statusCode: 500 });
    expect(mockWarnings.mock.calls).toEqual([
      ['[WS_CONTROL_FAILED] [ACTION AUTHENTICATE] [STAGE operation]']
    ]);
    expect(mockTransport).not.toHaveBeenCalled();
  });

  it('handles a throwing prototype trap as unexpected without cleanup or raw diagnostics', async () => {
    const { db, invoke } = fixture(WsMessageType.AUTHENTICATE);
    db.operationFailure = new Proxy(new Error('PRIVATE_ERROR_CANARY'), {
      getPrototypeOf() {
        throw new Error('PRIVATE_TRAP_CANARY');
      }
    });
    expect(await invoke()).toMatchObject({ statusCode: 500 });
    expect(mockTransport).not.toHaveBeenCalled();
    expect(mockWarnings.mock.calls).toEqual([
      ['[WS_CONTROL_FAILED] [ACTION AUTHENTICATE] [STAGE operation]']
    ]);
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('preserves best-effort close behavior for existing deregistration callers', async () => {
    const db = new ConnectionDatabase();
    const repository = new WsConnectionRepository(
      () => db,
      {} as never,
      () => false
    );
    const realSockets = new sockets.AppWebSockets(repository);
    mockTransport.mockResolvedValue(response(403, 'ForbiddenException'));
    await expect(
      realSockets.deregister({ connectionId: 'synthetic-socket' })
    ).resolves.toBeUndefined();
    expect(db.cleanupWrites).toBe(2);
    expect(mockTransport).toHaveBeenCalledTimes(1);
  });
});
