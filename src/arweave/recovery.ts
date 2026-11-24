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
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () =>
          reject(
            controller.signal.reason ?? new Error('Arweave request aborted')
          );
        controller.signal.addEventListener('abort', rejectAbort, {
          once: true
        });
        timer = setTimeout(
          () =>
            controller.abort(
              new ArweaveTimeoutError(
                remaining <= (options.attemptTimeoutMs ?? 15_000)
                  ? 'overall'
                  : 'attempt'
              )
            ),
          Math.max(1, Math.min(remaining, options.attemptTimeoutMs ?? 15_000))
        );
      });
      if (options.signal?.aborted) abort();
      const result = await Promise.race([
        operation(urls[index], controller.signal),
        interrupted
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
        category:
          error instanceof ArweaveTimeoutError
            ? error.stage
            : 'request_or_content'
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
    }
  }
  throw lastError ?? new Error('No Arweave gateways available');
}
