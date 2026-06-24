import type { APIGatewayEvent, Context } from 'aws-lambda';
import { handler } from './handler';
import { WsMessageType } from './ws/ws-message';
import {
  appWebSockets,
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
    send: jest.fn(),
    register: jest.fn(),
    deregister: jest.fn(),
    updateActiveWaveForConnection: jest.fn()
  },
  authenticateWebSocketJwtOrGetByConnectionId: jest.fn(),
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

const appWebSocketsMock = appWebSockets as jest.Mocked<typeof appWebSockets>;
const authenticateWebSocketJwtOrGetByConnectionIdMock =
  authenticateWebSocketJwtOrGetByConnectionId as jest.MockedFunction<
    typeof authenticateWebSocketJwtOrGetByConnectionId
  >;
const authenticateWebSocketTokenMock =
  authenticateWebSocketToken as jest.MockedFunction<
    typeof authenticateWebSocketToken
  >;

describe('handler websocket auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
