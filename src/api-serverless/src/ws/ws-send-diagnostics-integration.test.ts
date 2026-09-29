jest.mock('@/api/ws/ws-outbound-queue', () => ({
  ...jest.requireActual('@/api/ws/ws-outbound-queue'),
  enqueueWebSocketFrame: jest.fn()
}));
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

import type { SQSEvent } from 'aws-lambda';
import { processWebSocketBatch } from '@/websocketOutboundHandler/processor';
import { deferWebSocketRetry } from '@/websocketOutboundHandler/retry';
import { SQSClient, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { enqueueWebSocketFrame } from './ws-outbound-queue';
import { HttpResponse } from '@smithy/protocol-http';
import { NftLinkRefreshNotifier } from '@/nftLinkRefresherLoop/nft-link-refresh-notifier';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { AppWebSockets, appWebSockets } from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { withLambdaRemainingTime } from '@/lambda-deadline';
import {
  WebSocketSendScheduler,
  WebSocketSendLimitError
} from './ws-send-scheduler';

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
      identity_id: 'profile',
      jwt_expiry: 2000000000
    })),
    deleteByConnectionId: jest.fn(async () => undefined),
    findNotificationConnectionIdsByIdentityIds: jest.fn(),
    canIdentityReadQueuedResource: jest.fn()
  };
  const sockets = new AppWebSockets(
    repository as unknown as WsConnectionRepository
  );
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });
  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockHandle.mockReset();
    mockError.mockClear();
    mockWarn.mockClear();
    mockAttempts.length = 0;
    (enqueueWebSocketFrame as jest.Mock).mockReset();
    repository.deleteByConnectionId.mockClear();
    repository.getByConnectionId.mockClear();
    repository.findNotificationConnectionIdsByIdentityIds.mockReset();
    repository.canIdentityReadQueuedResource.mockReset();
  });

  it('persists production sends without attempting transport, even with low invocation budget', async () => {
    await withLambdaRemainingTime(
      () => 900,
      () => sockets.send({ connectionId: 'synthetic', message: '{}' })
    );
    expect(enqueueWebSocketFrame).toHaveBeenCalledWith(
      {
        connectionId: 'synthetic',
        message: '{}',
        identityId: 'profile',
        jwtExpiry: 2000000000
      },
      undefined
    );
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('queues the NFT refresher default producer and delivers its public media payload through the worker', async () => {
    jest
      .spyOn(appWebSockets, 'send')
      .mockImplementation((input) => sockets.send(input));
    const data = { canonical_id: 'synthetic-link' } as ApiNftLinkData;
    const notifier = new NftLinkRefreshNotifier(async () => [
      {
        connection_id: 'synthetic',
        jwt_expiry: 2000000000
      }
    ]);
    await notifier.notifyAboutNftLinkUpdate(data);
    const [frame, signal] = (enqueueWebSocketFrame as jest.Mock).mock.calls[0];
    expect(frame).toMatchObject({
      connectionId: 'synthetic',
      identityId: 'profile',
      jwtExpiry: 2000000000
    });
    expect(JSON.parse(frame.message)).toMatchObject({
      type: 'MEDIA_LINK_UPDATED',
      data
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mockHandle).not.toHaveBeenCalled();
    mockHandle.mockResolvedValueOnce(response(200));
    await sockets.deliverQueued({ ...frame, version: 1, id: 'nft-frame' });
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(repository.canIdentityReadQueuedResource).not.toHaveBeenCalled();
  });

  it('does not enqueue or delete a connection when cancellation occurs during the session read', async () => {
    const controller = new AbortController();
    repository.getByConnectionId.mockImplementationOnce(async () => {
      controller.abort();
      return { identity_id: 'profile', jwt_expiry: 2000000000 };
    });
    await expect(
      sockets.send({
        connectionId: 'synthetic',
        message: '{}',
        abortSignal: controller.signal
      })
    ).rejects.toThrow();
    expect(enqueueWebSocketFrame).not.toHaveBeenCalled();
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    expect(mockHandle).not.toHaveBeenCalled();
  });

  it('surfaces queue persistence failures without exposing provider payloads', async () => {
    (enqueueWebSocketFrame as jest.Mock).mockRejectedValueOnce(
      new Error('PRIVATE_PROVIDER_DATA')
    );
    await expect(
      sockets.send({ connectionId: 'synthetic', message: '{}' })
    ).rejects.toThrow('WebSocket queue persistence failed');
    expect(mockError).toHaveBeenCalledWith({
      code: 'WS_OUTBOUND_ENQUEUE_FAILED'
    });
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(
      'PRIVATE_PROVIDER_DATA'
    );
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('does not replay a frame after the connection has switched identity', async () => {
    await sockets.deliverQueued({
      version: 1,
      id: 'frame',
      connectionId: 'synthetic',
      message: '{}',
      identityId: 'previous-profile',
      jwtExpiry: 2000000000
    });
    expect(mockHandle).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith({
      code: 'WS_OUTBOUND_SESSION_CHANGED'
    });
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('retries a durably queued frame after three 429s and acknowledges its later success', async () => {
    const frame = {
      version: 1 as const,
      id: 'frame',
      connectionId: 'synthetic',
      message: '{}',
      identityId: 'profile',
      jwtExpiry: 2000000000
    };
    mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
    await expect(sockets.deliverQueued(frame)).rejects.toBeDefined();
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    mockHandle.mockResolvedValue(response(204));
    await expect(sockets.deliverQueued(frame)).resolves.toBeUndefined();
    expect(mockHandle).toHaveBeenCalledTimes(4);
    expect(enqueueWebSocketFrame).not.toHaveBeenCalled();
  });

  it('retains an SDK-exhausted 429 at the SQS boundary, defers it, and acknowledges redelivery', async () => {
    const batch = {
      Records: [
        {
          messageId: 'durable-frame',
          receiptHandle: 'test-receipt',
          attributes: { ApproximateReceiveCount: '1' },
          body: JSON.stringify({
            version: 1,
            id: 'durable-frame',
            connectionId: 'synthetic',
            message: '{}',
            identityId: 'profile',
            jwtExpiry: 2000000000
          })
        }
      ]
    } as SQSEvent;
    const originalQueueUrl = process.env.WS_OUTBOUND_QUEUE_URL;
    process.env.WS_OUTBOUND_QUEUE_URL =
      'https://sqs.synthetic.invalid/test.fifo';
    const visibility = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const report = jest.fn();
    const consume = () =>
      processWebSocketBatch(
        batch,
        (frame) => sockets.deliverQueued(frame),
        report,
        deferWebSocketRetry
      );
    try {
      mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
      expect(await consume()).toEqual({
        batchItemFailures: [{ itemIdentifier: 'durable-frame' }]
      });
      expect(mockHandle).toHaveBeenCalledTimes(3);
      expect(report).toHaveBeenCalledTimes(1);
      expect(visibility).toHaveBeenCalledTimes(1);
      const command = visibility.mock
        .calls[0][0] as ChangeMessageVisibilityCommand;
      expect(command.input).toMatchObject({
        QueueUrl: process.env.WS_OUTBOUND_QUEUE_URL,
        ReceiptHandle: 'test-receipt'
      });
      expect(command.input.VisibilityTimeout).toBeGreaterThanOrEqual(1);
      expect(command.input.VisibilityTimeout).toBeLessThanOrEqual(2);
      mockHandle.mockResolvedValue(response(204));
      batch.Records[0]!.attributes.ApproximateReceiveCount = '2';
      expect(await consume()).toEqual({ batchItemFailures: [] });
      expect(mockHandle).toHaveBeenCalledTimes(4);
      expect(visibility).toHaveBeenCalledTimes(1);
      expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    } finally {
      if (originalQueueUrl === undefined)
        delete process.env.WS_OUTBOUND_QUEUE_URL;
      else process.env.WS_OUTBOUND_QUEUE_URL = originalQueueUrl;
    }
  });

  it('retains a worker deadline failure and delivers the same record on the next invocation', async () => {
    const batch = {
      Records: [
        {
          messageId: 'deadline-frame',
          body: JSON.stringify({
            version: 1,
            id: 'deadline-frame',
            connectionId: 'synthetic',
            message: '{}',
            identityId: 'profile',
            jwtExpiry: 2000000000
          })
        }
      ]
    } as SQSEvent;
    const consume = () =>
      processWebSocketBatch(
        batch,
        (frame) => sockets.deliverQueued(frame),
        jest.fn()
      );
    expect(await withLambdaRemainingTime(() => 900, consume)).toEqual({
      batchItemFailures: [{ itemIdentifier: 'deadline-frame' }]
    });
    expect(mockHandle).not.toHaveBeenCalled();
    mockHandle.mockResolvedValue(response(204));
    expect(await consume()).toEqual({ batchItemFailures: [] });
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('permits duplicate delivery when an acknowledgement is lost; it does not promise exactly once', async () => {
    const batch = {
      Records: [
        {
          messageId: 'replayed-frame',
          body: JSON.stringify({
            version: 1,
            id: 'replayed-frame',
            connectionId: 'synthetic',
            message: '{}',
            identityId: 'profile',
            jwtExpiry: 2000000000
          })
        }
      ]
    } as SQSEvent;
    mockHandle.mockResolvedValue(response(204));
    for (let delivery = 0; delivery < 2; delivery++) {
      expect(
        await processWebSocketBatch(
          batch,
          (frame) => sockets.deliverQueued(frame),
          jest.fn()
        )
      ).toEqual({ batchItemFailures: [] });
    }
    expect(mockHandle).toHaveBeenCalledTimes(2);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('does not deliver queued notification data after its subscription is removed', async () => {
    repository.findNotificationConnectionIdsByIdentityIds.mockResolvedValue([]);
    await sockets.deliverQueued({
      version: 1,
      id: 'frame',
      connectionId: 'synthetic',
      message: JSON.stringify({
        type: 'DM_UNREAD_STATE_CHANGED',
        data: { profile_id: 'other', wave_id: 'private-wave' }
      }),
      identityId: 'profile',
      jwtExpiry: 2000000000
    });
    expect(mockHandle).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith({
      code: 'WS_OUTBOUND_SUBSCRIPTION_CHANGED'
    });
  });

  it('checks private-wave access for the subscribed DM profile before retrying', async () => {
    repository.findNotificationConnectionIdsByIdentityIds.mockResolvedValue([
      { connectionId: 'synthetic', identityId: 'other' }
    ]);
    repository.canIdentityReadQueuedResource.mockResolvedValue(false);
    await sockets.deliverQueued({
      version: 1,
      id: 'frame',
      connectionId: 'synthetic',
      message: JSON.stringify({
        type: 'DM_UNREAD_STATE_CHANGED',
        data: { profile_id: 'other', wave_id: 'private-wave' }
      }),
      identityId: 'profile',
      jwtExpiry: 2000000000
    });
    expect(repository.canIdentityReadQueuedResource).toHaveBeenCalledWith(
      'other',
      { waveId: 'private-wave' }
    );
    expect(mockHandle).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith({
      code: 'WS_OUTBOUND_ACCESS_CHANGED'
    });
  });

  it('reports an exhausted invocation budget without transport, database lookup or deregistration', async () => {
    await expect(
      withLambdaRemainingTime(
        () => 900,
        () =>
          sockets.deliver({
            connectionId: 'private-connection',
            message: '{"type":"DROP_DELETE"}'
          })
      )
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    expect(mockHandle).not.toHaveBeenCalled();
    expect(repository.getByConnectionId).not.toHaveBeenCalled();
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      code: 'WS_OUTBOUND_SEND_FAILED',
      delivery_failure: 'DEADLINE_EXCEEDED',
      sdk_attempts: null,
      frame_type: 'DROP_DELETE',
      connection_hash: expect.stringMatching(/^[a-f0-9]{24}$/)
    });
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(
      'private-connection'
    );
  });

  it('reports bounded queue overflow once and retains the connection', async () => {
    jest
      .spyOn(WebSocketSendScheduler.prototype, 'send')
      .mockRejectedValueOnce(new WebSocketSendLimitError('QUEUE_FULL'));
    await expect(
      sockets.deliver({
        connectionId: 'private-connection',
        message: '{"type":"DROP_UPDATE"}'
      })
    ).rejects.toMatchObject({ reason: 'QUEUE_FULL' });
    expect(mockHandle).not.toHaveBeenCalled();
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      delivery_failure: 'QUEUE_FULL'
    });
  });

  it('aborts active SDK transport at the invocation budget without deleting the connection', async () => {
    mockHandle.mockImplementation(
      (_request, { abortSignal }) =>
        new Promise((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (abortSignal.aborted) abort();
          else abortSignal.addEventListener('abort', abort, { once: true });
        })
    );
    await expect(
      withLambdaRemainingTime(
        () => 2_000,
        () =>
          sockets.deliver({
            connectionId: 'synthetic',
            message: '{"type":"DROP_UPDATE"}'
          })
      )
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      delivery_failure: 'DEADLINE_EXCEEDED'
    });
  });

  it('already retries two 429 responses and succeeds on SDK attempt three', async () => {
    mockHandle
      .mockResolvedValueOnce(response(429, 'LimitExceededException'))
      .mockResolvedValueOnce(response(429, 'LimitExceededException'))
      .mockResolvedValueOnce(response(204));
    await expect(
      sockets.deliver({
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

  it('exhausted 429 delivery rejects for durable retry, logs metadata and keeps the connection', async () => {
    mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
    await expect(
      sockets.deliver({
        connectionId: 'synthetic',
        message: '{"type":"AUTHENTICATED"}',
        skipStaleConnectionCheck: true
      })
    ).rejects.toBeDefined();
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
      /synthetic|fixed|secret|connectionId/
    );
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('403 rejects for queue retention without deleting the connection', async () => {
    mockHandle.mockResolvedValue(response(403, 'ForbiddenException'));
    await expect(
      sockets.deliver({ connectionId: 'synthetic', message: '{}' })
    ).rejects.toBeDefined();
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('410 alone takes the stale-connection cleanup path', async () => {
    mockHandle
      .mockResolvedValueOnce(response(410, 'GoneException'))
      .mockResolvedValueOnce(response(204));
    await expect(
      sockets.deliver({ connectionId: 'synthetic', message: '{}' })
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

  it('a throwing error logger still propagates the send failure for retry', async () => {
    mockHandle.mockResolvedValue(response(429, 'LimitExceededException'));
    mockError.mockImplementationOnce(() => {
      throw new Error('synthetic logger failure');
    });
    await expect(
      sockets.deliver({
        connectionId: 'synthetic',
        message: '{"type":"USER_IS_TYPING"}'
      })
    ).rejects.toBeDefined();
    expect(mockHandle).toHaveBeenCalledTimes(3);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(repository.deleteByConnectionId).not.toHaveBeenCalled();
  });

  it('twenty application sends are drained with at most sixteen concurrent SDK operations', async () => {
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
        sockets.deliver({ connectionId: `synthetic-${index}`, message: '{}' })
      )
    );
    expect(mockHandle).toHaveBeenCalledTimes(20);
    expect(peak).toBe(16);
  });
});
