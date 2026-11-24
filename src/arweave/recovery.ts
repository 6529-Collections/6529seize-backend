import { Logger } from '@/logging';

const logger = Logger.get('ARWEAVE_RECOVERY');

export class ArweaveTimeoutError extends Error {
  constructor(readonly stage: 'attempt' | 'overall' | 'body_idle') {
    super(`Arweave ${stage} deadline exceeded`);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ArweaveRecoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export function isArweavePolicyRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      'NftPreviewOversizeError',
      'PublicResponseTooLargeError',
      'PublicNetworkPolicyError'
    ].includes(error.name)
  );
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

interface GatewayAttempt {
  signal: AbortSignal;
  interrupted: Promise<never>;
  close(): void;
}

function gatewayAttempt(
  parent: AbortSignal | undefined,
  remaining: number,
  attemptTimeoutMs: number
): GatewayAttempt {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const rejectAbort = () => rejectInterrupted(controller.signal.reason);
  let rejectInterrupted!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(
        new ArweaveTimeoutError(
          remaining <= attemptTimeoutMs ? 'overall' : 'attempt'
        )
      ),
    Math.max(1, Math.min(remaining, attemptTimeoutMs))
  );
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    interrupted,
    close: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
    }
  };
}

function failureCategory(error: unknown): string {
  return error instanceof ArweaveTimeoutError
    ? error.stage
    : 'request_or_content';
}

/** The callback must use the supplied signal and finish validation before returning. */
export async function recoverArweave<T>(
  candidates: readonly string[],
  operation: (url: string, signal: AbortSignal) => Promise<T>,
  options: ArweaveRecoveryOptions = {}
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let lastError: unknown;
  const urls = Array.from(new Set(candidates));
  for (let index = 0; index < urls.length; index++) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ArweaveTimeoutError('overall');
    const attempt = gatewayAttempt(
      options.signal,
      remaining,
      options.attemptTimeoutMs ?? 15_000
    );
    const startedAt = Date.now();
    try {
      const result = await Promise.race([
        operation(urls[index], attempt.signal),
        attempt.interrupted
      ]);
      if (index > 0)
        logger.info({
          event: 'arweave_recovered',
          gateway: host(urls[index]),
          attempt: index + 1,
          elapsed_ms: Date.now() - startedAt
        });
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (
        isArweavePolicyRejection(error) ||
        options.shouldRetry?.(error) === false
      )
        throw error;
      lastError = error;
      logger.info({
        event: 'arweave_attempt_failed',
        gateway: host(urls[index]),
        attempt: index + 1,
        elapsed_ms: Date.now() - startedAt,
        category: failureCategory(error)
      });
    } finally {
      attempt.close();
    }
  }
  throw lastError ?? new Error('No Arweave gateways available');
}
