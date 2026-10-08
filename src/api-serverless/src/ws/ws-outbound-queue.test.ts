jest.mock('@/sqs', () => ({ sqs: { sendToQueueName: jest.fn() } }));
import { sqs } from '@/sqs';
import {
  enqueueWebSocketFrame,
  parseQueuedWebSocketFrame
} from './ws-outbound-queue';

const frame = {
  connectionId: 'private-session',
  message: '{"type":"DROP_DELETE"}',
  identityId: 'profile',
  jwtExpiry: 2000000000
};
const send = sqs.sendToQueueName as jest.Mock;
beforeEach(() => send.mockReset());
it('persists each frame with the same per-connection group and distinct deduplication content', async () => {
  await enqueueWebSocketFrame(frame);
  await enqueueWebSocketFrame(frame);
  const first = send.mock.calls[0][0],
    second = send.mock.calls[1][0];
  expect(first.queueName).toBe('websocket-outbound.fifo');
  expect(first.messageGroupId).toBe(second.messageGroupId);
  expect(first.messageGroupId).not.toContain('private-session');
  expect(first.message.id).not.toBe(second.message.id);
  expect(
    parseQueuedWebSocketFrame(JSON.stringify(first.message))
  ).toMatchObject(frame);
});
it('propagates failed persistence instead of reporting success', async () => {
  send.mockRejectedValue(new Error('queue unavailable'));
  await expect(enqueueWebSocketFrame(frame)).rejects.toThrow(
    'queue unavailable'
  );
});

it('preserves the producer cancellation signal through queue persistence', async () => {
  const abortSignal = new AbortController().signal;
  await enqueueWebSocketFrame(frame, abortSignal);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ abortSignal }));
});

it('reuses the durable outbox envelope after an ambiguous acceptance or commit', async () => {
  await enqueueWebSocketFrame(frame, undefined, 'outbox:99');
  await enqueueWebSocketFrame(frame, undefined, 'outbox:99');
  expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
});

it.each([undefined, 'durable_updates_v1'])(
  'accepts historical and known capability envelopes: %s',
  (deliveryCapability) => {
    const envelope = { ...frame, id: 'event', version: 1, deliveryCapability };
    expect(parseQueuedWebSocketFrame(JSON.stringify(envelope))).toMatchObject(
      frame
    );
  }
);
it('retains unknown capability envelopes as malformed instead of falling back to legacy delivery', () => {
  expect(() =>
    parseQueuedWebSocketFrame(
      JSON.stringify({
        ...frame,
        id: 'event',
        version: 1,
        deliveryCapability: 'future'
      })
    )
  ).toThrow('Invalid queued WebSocket frame');
});
