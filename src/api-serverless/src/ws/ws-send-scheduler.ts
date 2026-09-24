import { getLambdaRemainingTime } from '@/lambda-deadline';

export const WS_SEND_CONCURRENCY = 16;
const MAX_PENDING_SENDS = 256;
const SEND_TIMEOUT_MS = 5_000;
const INVOCATION_RESERVE_MS = 1_000;

export function hasWebSocketSendBudget(): boolean {
  return getLambdaRemainingTime() > INVOCATION_RESERVE_MS;
}

export class WebSocketSendLimitError extends Error {
  constructor(readonly reason: 'QUEUE_FULL' | 'DEADLINE_EXCEEDED') {
    super(reason);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface PendingSend {
  connectionId: string;
  start: () => void;
}

/** Process-local pressure control, not a distributed rate limiter or replay queue. */
export class WebSocketSendScheduler {
  private readonly activeConnections = new Set<string>();
  private readonly pending: PendingSend[] = [];

  constructor(
    private readonly concurrency = WS_SEND_CONCURRENCY,
    private readonly maxPending = MAX_PENDING_SENDS
  ) {}

  async send(
    connectionId: string,
    operation: (signal: AbortSignal) => Promise<void>,
    timeoutMs = SEND_TIMEOUT_MS
  ): Promise<void> {
    const budget = Math.min(
      timeoutMs,
      getLambdaRemainingTime() - INVOCATION_RESERVE_MS
    );
    if (budget <= 0) {
      throw new WebSocketSendLimitError('DEADLINE_EXCEEDED');
    }
    const canStart =
      this.activeConnections.size < this.concurrency &&
      !this.activeConnections.has(connectionId);
    if (!canStart && this.pending.length >= this.maxPending) {
      throw new WebSocketSendLimitError('QUEUE_FULL');
    }
    const deadline = Date.now() + budget;
    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      const expire = () => {
        if (started) {
          controller.abort();
        } else {
          this.removePending(entry);
          reject(new WebSocketSendLimitError('DEADLINE_EXCEEDED'));
        }
      };
      const timer = setTimeout(expire, budget);
      const entry: PendingSend = {
        connectionId,
        start: () => {
          // Timers may be delayed while a large recipient payload is serialized.
          if (Date.now() >= deadline) {
            clearTimeout(timer);
            reject(new WebSocketSendLimitError('DEADLINE_EXCEEDED'));
            return;
          }
          started = true;
          this.activeConnections.add(connectionId);
          void this.execute(operation, controller, deadline)
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(timer);
              this.activeConnections.delete(connectionId);
              this.drain();
            });
        }
      };
      if (canStart) entry.start();
      else this.pending.push(entry);
    });
  }

  private async execute(
    operation: (signal: AbortSignal) => Promise<void>,
    controller: AbortController,
    deadline: number
  ): Promise<void> {
    try {
      await operation(controller.signal);
    } catch (error) {
      // Never release a permit via Promise.race while the SDK is still sending.
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new WebSocketSendLimitError('DEADLINE_EXCEEDED');
      }
      throw error;
    }
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new WebSocketSendLimitError('DEADLINE_EXCEEDED');
    }
  }

  private removePending(entry: PendingSend): void {
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private drain(): void {
    while (this.activeConnections.size < this.concurrency) {
      // Skip busy connections; preserve FIFO ordering within each connection.
      const index = this.pending.findIndex(
        (entry) => !this.activeConnections.has(entry.connectionId)
      );
      if (index < 0) return;
      this.pending.splice(index, 1)[0]!.start();
    }
  }
}

/** Lazily create recipient payloads and await every send, including after errors. */
export async function forEachWebSocketRecipient<T>(
  recipients: Iterable<T>,
  send: (recipient: T) => Promise<void>
): Promise<void> {
  const iterator = recipients[Symbol.iterator]();
  const failures: { error: unknown }[] = [];
  const worker = async () => {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      try {
        await send(next.value);
      } catch (error) {
        if (!failures.length) failures.push({ error });
      }
    }
  };
  await Promise.all(Array.from({ length: WS_SEND_CONCURRENCY }, worker));
  if (failures.length) throw failures[0]!.error;
}
