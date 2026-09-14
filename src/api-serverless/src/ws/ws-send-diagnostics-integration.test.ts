const mockHandle = jest.fn();
const mockError = jest.fn();
const mockWarn = jest.fn();
const mockAttempts: string[] = [];

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      error: mockError,
      warn: mockWarn,
      info: jest.fn(),
      debug: jest.fn()
    })
  }
}));
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  const actual = jest.requireActual('@aws-sdk/client-apigatewaymanagementapi');
  return {
    ...actual,
    ApiGatewayManagementApiClient: jest.fn(function (
      config: Record<string, unknown>
    ) {
      return new actual.ApiGatewayManagementApiClient({
        ...config,
        endpoint: 'https://synthetic.invalid',
        region: 'us-east-1',
        credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
        retryMode: 'standard',
        maxAttempts: 3,
        requestHandler: {
          handle: (...args: unknown[]) => {
            mockAttempts.push(
              (args[0] as { headers: Record<string, string> }).headers[
                'amz-sdk-request'
              ]
            );
            return mockHandle(...args);
          }
        }
      });
    })
  };
});

import { HttpResponse } from '@smithy/protocol-http';
import { AppWebSockets } from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';

const response = (statusCode: number, errorType?: string) => ({
  response: new HttpResponse({
    statusCode,
    headers: {
      'content-type': 'application/json',
      ...(errorType ? { 'x-amzn-errortype': errorType } : {})
    },
    body: Buffer.from(
      errorType ? JSON.stringify({ message: 'fixed synthetic error' }) : ''
    )
  })
});

describe('WebSocket terminal diagnostics with real SDK middleware and synthetic transport', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const repository = {
    getByConnectionId: jest.fn(async () => ({
      jwt_expiry: Math.floor(Date.now() / 1000) + 600
    })),
    deleteByConnectionId: jest.fn(async () => undefined)
  };
  const sockets = new AppWebSockets(
    repository as unknown as WsConnectionRepository
  );
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockHandle.mockReset();
    mockError.mockClear();
    mockWarn.mockClear();
    mockAttempts.length = 0;
    repository.deleteByConnectionId.mockClear();
  });

  it('already retries two 429 responses and succeeds on SDK attempt three', async () => {
    mockHandle
      .mockResolvedValueOnce(response(429, 'LimitExceededException'))
      .mockResolvedValueOnce(response(429, 'LimitExceededException'))
      .mockResolvedValueOnce(response(204));
    await expect(
      sockets.send({
        connectionId: 'synthetic',
        message: '{"type":"USER_IS_TYPING"}'
      })
    ).resolves.toBeUndefined();
    expect(mockHandle).toHaveBeenCalledTimes(3);
    expect(mockAttempts).toEqual([
      'attempt=1; max=3',
      'attempt=2; max=3',
      'attempt=3; max=3'
    ]);
    expect(mockError).not.toHaveBeenCalled();
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('exhausted 429 delivery still resolves normally, logs attempt metadata and keeps the live connection', async () => {
    mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
    await expect(
      sockets.send({
        connectionId: 'synthetic',
        message: '{"type":"AUTHENTICATED"}',
        skipStaleConnectionCheck: true
      })
    ).resolves.toBeUndefined();
    expect(mockHandle).toHaveBeenCalledTimes(3);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      code: 'WS_OUTBOUND_SEND_FAILED',
      frame_type: 'AUTHENTICATED',
      error_category: 'THROTTLED',
      http_status: 429,
      sdk_attempts: 3
    });
    expect(mockError.mock.calls[0][0].sdk_retry_delay_ms).toEqual(
      expect.any(Number)
    );
    expect(JSON.stringify(mockError.mock.calls[0][0])).not.toMatch(
      /synthetic|fixed|secret|connection/
    );
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('permanent 403 is not retried but is also swallowed without deleting the connection', async () => {
    mockHandle.mockResolvedValue(response(403, 'ForbiddenException'));
    await expect(
      sockets.send({ connectionId: 'synthetic', message: '{}' })
    ).resolves.toBeUndefined();
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('410 alone takes the stale-connection cleanup path', async () => {
    mockHandle
      .mockResolvedValueOnce(response(410, 'GoneException'))
      .mockResolvedValueOnce(response(204));
    await expect(
      sockets.send({ connectionId: 'synthetic', message: '{}' })
    ).resolves.toBeUndefined();
    expect(mockHandle.mock.calls.map(([request]) => request.method)).toEqual([
      'POST',
      'DELETE'
    ]);
    expect(repository.deleteByConnectionId).toHaveBeenCalledWith(
      'synthetic',
      {}
    );
    expect(mockError).not.toHaveBeenCalled();
  });

  it('a throwing error logger does not delete a live throttled connection or reject its caller', async () => {
    mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
    mockError.mockImplementationOnce(() => {
      throw new Error('synthetic logger failure');
    });
    await expect(
      sockets.send({
        connectionId: 'synthetic',
        message: '{"type":"USER_IS_TYPING"}'
      })
    ).resolves.toBeUndefined();
    expect(mockHandle).toHaveBeenCalledTimes(3);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('twenty application sends can reach the SDK transport concurrently without an application limiter', async () => {
    let inflight = 0;
    let peak = 0;
    mockHandle.mockImplementation(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inflight--;
      return response(204);
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        sockets.send({ connectionId: `synthetic-${index}`, message: '{}' })
      )
    );
    expect(mockHandle).toHaveBeenCalledTimes(20);
    expect(peak).toBe(20);
  });
});
