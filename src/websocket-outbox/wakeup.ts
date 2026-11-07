import { randomUUID } from 'node:crypto';
import { sqs } from '@/sqs';
import { WS_OUTBOUND_QUEUE } from '@/api/ws/ws-outbound-queue';
import { Logger } from '@/logging';

export const OUTBOX_WAKEUP = 'WEBSOCKET_OUTBOX_WAKEUP';
/** Latency hint only: the scheduled drain recovers if this post-commit enqueue fails. */
export async function wakeWebSocketOutbox(): Promise<void> {
  try {
    await sqs.sendToQueueName({
      queueName: WS_OUTBOUND_QUEUE,
      messageGroupId: 'outbox-wakeup',
      message: { type: OUTBOX_WAKEUP, id: randomUUID() },
      abortSignal: AbortSignal.timeout(2000)
    });
  } catch {
    Logger.get('WEBSOCKET_OUTBOX').error({ code: 'WS_OUTBOX_WAKEUP_FAILED' });
  }
}
