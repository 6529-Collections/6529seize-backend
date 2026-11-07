import { randomUUID, createHash } from 'node:crypto';
import { sqs } from '@/sqs';
import { DURABLE_UPDATES_CAPABILITY } from './ws-shared';

export const WS_OUTBOUND_QUEUE = 'websocket-outbound.fifo';
export interface QueuedWebSocketFrame {
  version: 1;
  id: string;
  connectionId: string;
  message: string;
  identityId: string | null;
  jwtExpiry: number;
  deliveryCapability?: typeof DURABLE_UPDATES_CAPABILITY;
}

/** Persist a session-bound frame in its connection FIFO group; reject failed acceptance. */
export async function enqueueWebSocketFrame(
  frame: Omit<QueuedWebSocketFrame, 'version' | 'id'>,
  abortSignal?: AbortSignal,
  id: string = randomUUID()
): Promise<void> {
  // The unique envelope ID prevents identical, intentional updates from being
  // suppressed by FIFO content deduplication. SDK retries reuse this envelope.
  await sqs.sendToQueueName({
    queueName: WS_OUTBOUND_QUEUE,
    abortSignal,
    // Unlike diagnostic hashes, this must remain stable across UTC days.
    messageGroupId: createHash('sha256')
      .update(frame.connectionId)
      .digest('hex'),
    message: { ...frame, version: 1, id }
  });
}

/** Reject malformed envelopes so the consumer retains them for retry and DLQ inspection. */
export function parseQueuedWebSocketFrame(body: string): QueuedWebSocketFrame {
  const frame = JSON.parse(body) as Partial<QueuedWebSocketFrame> | null;
  if (
    frame?.version !== 1 ||
    (frame.deliveryCapability !== undefined &&
      frame.deliveryCapability !== DURABLE_UPDATES_CAPABILITY) ||
    typeof frame.id !== 'string' ||
    !frame.id ||
    typeof frame.connectionId !== 'string' ||
    !frame.connectionId ||
    typeof frame.message !== 'string' ||
    !(frame.identityId === null || typeof frame.identityId === 'string') ||
    typeof frame.jwtExpiry !== 'number' ||
    !Number.isSafeInteger(frame.jwtExpiry)
  )
    throw new Error('Invalid queued WebSocket frame');
  return frame as QueuedWebSocketFrame;
}
