import type { APIGatewayEvent, Context } from 'aws-lambda';
import { WsMessageType } from './ws/ws-message';
import {
  appWebSockets,
  authenticateNotificationIdentityTokens,
  authenticateWebSocketJwtOrGetByConnectionId,
  authenticateWebSocketToken
} from './ws/ws';

const mockHttpHandler = jest.fn();

jest.mock('serverless-http', () => jest.fn(() => mockHttpHandler));

jest.mock('../../sentry.context', () => ({
  wrapLambdaHandler: jest.fn((fn) => fn)
}));

jest.mock('../../logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    }))
  }
}));

jest.mock('./app', () => ({
  app: {},
  ensureInitialized: jest.fn(async () => undefined)
}));

jest.mock('./ws/ws', () => ({
  appWebSockets: {
    authenticateConnection: jest.fn(),
    syncNotificationIdentities: jest.fn(),
    send: jest.fn(),
    register: jest.fn(),
    deregister: jest.fn(),
    updateActiveWaveForConnection: jest.fn()
  },
  authenticateWebSocketJwtOrGetByConnectionId: jest.fn(),
  authenticateNotificationIdentityTokens: jest.fn(),
  authenticateWebSocketToken: jest.fn()
}));

jest.mock('./ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {
    notifyAboutUserIsTyping: jest.fn()
  }
}));

jest.mock('./ws/ws-log-redaction', () => ({
  redactWebSocketMessageForLog: jest.fn((message) => message)
}));

const { handler } = require('./handler') as typeof import('./handler');
const appWebSocketsMock = appWebSockets as jest.Mocked<typeof appWebSockets>;
const authenticateWebSocketJwtOrGetByConnectionIdMock =
  authenticateWebSocketJwtOrGetByConnectionId as jest.MockedFunction<
    typeof authenticateWebSocketJwtOrGetByConnectionId
  >;
const authenticateWebSocketTokenMock =
  authenticateWebSocketToken as jest.MockedFunction<
    typeof authenticateWebSocketToken
  >;
const authenticateNotificationIdentityTokensMock =
  authenticateNotificationIdentityTokens as jest.MockedFunction<
    typeof authenticateNotificationIdentityTokens
  >;
type HttpHandlerResult = {
  readonly headers?: Record<string, unknown>;
  readonly multiValueHeaders?: Record<string, string[]>;
  readonly cookies?: string[];
};

describe('handler websocket auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHttpHandler.mockReset();
    authenticateWebSocketJwtOrGetByConnectionIdMock.mockResolvedValue({
      identityId: 'stale-identity',
      jwtExpiry: 100
    });
  });

  it('sends AUTHENTICATED without the stale connection check after reauth', async () => {
    authenticateWebSocketTokenMock.mockResolvedValue({
      identityId: 'fresh-identity',
      jwtExpiry: 200
    });

    const event = {
      httpMethod: 'POST',
      requestContext: {
        routeKey: '$default',
        connectionId: 'connection-1',
        requestId: 'request-1'
      },
      body: JSON.stringify({
        type: WsMessageType.AUTHENTICATE,
        access_token: 'fresh-access-token'
      })
    } as unknown as APIGatewayEvent;
    const context = {
      awsRequestId: 'lambda-request-1'
    } as Context;

    await expect(handler(event, context, jest.fn())).resolves.toEqual({
      statusCode: 200,
      body: JSON.stringify({ message: 'OK' })
    });

    expect(appWebSocketsMock.authenticateConnection).toHaveBeenCalledWith(
      {
        connectionId: 'connection-1',
        identityId: 'fresh-identity',
        jwtExpiry: 200
      },
      {}
    );
    expect(appWebSocketsMock.send).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      message: JSON.stringify({
        type: WsMessageType.AUTHENTICATED,
        identity_id: 'fresh-identity',
        expires_at: '1970-01-01T00:03:20.000Z'
      }),
      skipStaleConnectionCheck: true
    });
  });

  it('acknowledges only notification identities authenticated from supplied tokens', async () => {
    authenticateNotificationIdentityTokensMock.mockResolvedValue([
      { identityId: 'profile-1', jwtExpiry: 200 },
      { identityId: 'profile-2', jwtExpiry: 300 }
    ]);
    appWebSocketsMock.syncNotificationIdentities.mockResolvedValue([
      'profile-1',
      'profile-2'
    ]);

    const event = {
      httpMethod: 'POST',
      requestContext: {
        routeKey: '$default',
        connectionId: 'connection-1',
        requestId: 'request-1'
      },
      body: JSON.stringify({
        type: WsMessageType.SYNC_NOTIFICATION_IDENTITIES,
        access_tokens: ['token-1', 'token-2']
      })
    } as unknown as APIGatewayEvent;

    await expect(
      handler(event, { awsRequestId: 'lambda-request-1' } as Context, jest.fn())
    ).resolves.toEqual({
      statusCode: 200,
      body: JSON.stringify({ message: 'OK' })
    });

    expect(authenticateNotificationIdentityTokensMock).toHaveBeenCalledWith([
      'token-1',
      'token-2'
    ]);
    expect(appWebSocketsMock.syncNotificationIdentities).toHaveBeenCalledWith(
      'connection-1',
      [
        { identityId: 'profile-1', jwtExpiry: 200 },
        { identityId: 'profile-2', jwtExpiry: 300 }
      ],
      {}
    );
    expect(appWebSocketsMock.send).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      message: JSON.stringify({
        type: WsMessageType.NOTIFICATION_IDENTITIES_SYNCED,
        data: { profile_ids: ['profile-1', 'profile-2'] }
      }),
      skipStaleConnectionCheck: true
    });
  });
});

describe('handler http responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHttpHandler.mockReset();
  });

  it('returns responses without Set-Cookie unchanged', async () => {
    const httpResponse = {
      statusCode: 200,
      headers: {
        'content-type': 'application/json'
      },
      body: '{}',
      isBase64Encoded: false
    };
    mockHttpHandler.mockResolvedValue(httpResponse);

    const result = await handler(
      {
        httpMethod: 'GET',
        path: '/api/settings',
        requestContext: {
          requestId: 'request-1'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-1'
      } as Context,
      jest.fn()
    );

    expect(result).toBe(httpResponse);
  });

  it('normalizes a single Set-Cookie header into repeated-cookie fields', async () => {
    const compatibilityCookie = '6529_session=session-a.secret; Path=/api/auth';
    mockHttpHandler.mockResolvedValue({
      statusCode: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': compatibilityCookie
      },
      body: '{}',
      isBase64Encoded: false
    });

    const result = (await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/session-login',
        requestContext: {
          requestId: 'request-2'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-2'
      } as Context,
      jest.fn()
    )) as HttpHandlerResult;

    expect(result.headers).toEqual({
      'content-type': 'application/json'
    });
    expect(result.multiValueHeaders).toEqual({
      'Set-Cookie': [compatibilityCookie]
    });
    expect(result.cookies).toBeUndefined();
  });

  it('preserves repeated Set-Cookie headers for API Gateway REST responses', async () => {
    const compatibilityCookie = '6529_session=session-a.secret; Path=/api/auth';
    const scopedCookie = '6529_session_scoped=session-a.secret; Path=/api/auth';
    mockHttpHandler.mockResolvedValue({
      statusCode: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': compatibilityCookie
      },
      multiValueHeaders: {
        'set-cookie': [compatibilityCookie, scopedCookie]
      },
      body: '{}',
      isBase64Encoded: false
    });

    const result = (await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/session-login',
        requestContext: {
          requestId: 'request-3'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-3'
      } as Context,
      jest.fn()
    )) as HttpHandlerResult;

    expect(result.headers).toEqual({
      'content-type': 'application/json'
    });
    expect(result.multiValueHeaders).toEqual({
      'Set-Cookie': [compatibilityCookie, scopedCookie]
    });
    expect(result.cookies).toBeUndefined();
  });

  it('copies normalized cookie arrays into REST multi-value headers', async () => {
    const compatibilityCookie = '6529_session=session-b.secret; Path=/api/auth';
    const scopedCookie = '6529_session_scoped=session-b.secret; Path=/api/auth';
    mockHttpHandler.mockResolvedValue({
      statusCode: 201,
      headers: {
        'content-type': 'application/json'
      },
      cookies: [compatibilityCookie, scopedCookie],
      body: '{}',
      isBase64Encoded: false
    });

    const result = (await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/session-refresh',
        requestContext: {
          requestId: 'request-4'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-4'
      } as Context,
      jest.fn()
    )) as HttpHandlerResult;

    expect(result.multiValueHeaders).toEqual({
      'Set-Cookie': [compatibilityCookie, scopedCookie]
    });
    expect(result.cookies).toBeUndefined();
  });

  it('copies normalized Set-Cookie values into HTTP API v2 cookies', async () => {
    const compatibilityCookie = '6529_session=session-c.secret; Path=/api/auth';
    const scopedCookie = '6529_session_scoped=session-c.secret; Path=/api/auth';
    mockHttpHandler.mockResolvedValue({
      statusCode: 201,
      headers: {
        'content-type': 'application/json'
      },
      multiValueHeaders: {
        'set-cookie': [compatibilityCookie, scopedCookie]
      },
      body: '{}',
      isBase64Encoded: false
    });

    const result = (await handler(
      {
        version: '2.0',
        httpMethod: 'POST',
        path: '/api/auth/session-refresh',
        requestContext: {
          requestId: 'request-5'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-5'
      } as Context,
      jest.fn()
    )) as HttpHandlerResult;

    expect(result.headers).toEqual({
      'content-type': 'application/json'
    });
    expect(result.multiValueHeaders).toBeUndefined();
    expect(result.cookies).toEqual([compatibilityCookie, scopedCookie]);
  });

  it('uses the last cookie for the same name, path, and domain', async () => {
    const staleCompatibilityCookie =
      '6529_session=stale.secret; Max-Age=0; Path=/api/auth';
    const freshCompatibilityCookie =
      '6529_session=fresh.secret; Max-Age=60; Path=/api/auth';
    const differentPathCookie =
      '6529_session=other.secret; Max-Age=60; Path=/api/other';
    mockHttpHandler.mockResolvedValue({
      statusCode: 201,
      headers: {
        'set-cookie': staleCompatibilityCookie
      },
      multiValueHeaders: {
        'set-cookie': [freshCompatibilityCookie, differentPathCookie]
      },
      body: '{}',
      isBase64Encoded: false
    });

    const result = (await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/session-refresh',
        requestContext: {
          requestId: 'request-6'
        }
      } as unknown as APIGatewayEvent,
      {
        awsRequestId: 'lambda-request-6'
      } as Context,
      jest.fn()
    )) as HttpHandlerResult;

    expect(result.multiValueHeaders).toEqual({
      'Set-Cookie': [freshCompatibilityCookie, differentPathCookie]
    });
    expect(result.cookies).toBeUndefined();
  });
});
