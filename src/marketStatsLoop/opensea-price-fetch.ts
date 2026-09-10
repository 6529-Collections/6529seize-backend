import { Logger } from '@/logging';
import { Time } from '@/time';

const logger = Logger.get('OPENSEA_PRICE_FETCH');
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 30000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
]);

class OpenSeaPriceFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
    readonly retryAfterMs = 0
  ) {
    super(message);
    Object.setPrototypeOf(this, OpenSeaPriceFetchError.prototype);
  }
}

function isTransientNetworkError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const details = current as { code?: unknown; cause?: unknown };
    if (
      typeof details.code === 'string' &&
      RETRYABLE_NETWORK_CODES.has(details.code)
    ) {
      return true;
    }
    current = details.cause;
  }
  return false;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (!header) return 0;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = Date.parse(header);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchPageOnce(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;

  try {
    response = await fetch(url, {
      headers: { 'x-api-key': process.env.OPENSEA_API_KEY! },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new OpenSeaPriceFetchError(
        `HTTP ${response.status}`,
        RETRYABLE_STATUSES.has(response.status),
        undefined,
        retryAfterMs(response)
      );
    }
    // Keep the timeout active until the body has finished downloading.
    return await response.json();
  } catch (error) {
    if (error instanceof OpenSeaPriceFetchError) throw error;
    throw new OpenSeaPriceFetchError(
      controller.signal.aborted
        ? `Request timed out after ${timeoutMs}ms`
        : errorMessage(error),
      controller.signal.aborted || isTransientNetworkError(error),
      error
    );
  } finally {
    clearTimeout(timeout);
    // Release unconsumed HTTP error bodies and failed/stalled body reads.
    controller.abort();
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}

export async function waitForOpenSeaPage(
  delayMs: number,
  deadlineMs: number,
  url: string,
  cause?: unknown
): Promise<void> {
  if (Date.now() + delayMs >= deadlineMs) {
    throw new OpenSeaPriceFetchError(
      `[OPENSEA] Price fetch deadline exceeded for ${url}`,
      false,
      cause
    );
  }
  await Time.millis(delayMs).sleep();
}

export async function fetchOpenSeaPricePage(
  url: string,
  deadlineMs: number
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`[OPENSEA] Price fetch deadline exceeded for ${url}`);
    }

    try {
      return await fetchPageOnce(
        url,
        Math.min(REQUEST_TIMEOUT_MS, remainingMs)
      );
    } catch (error) {
      const retryable =
        error instanceof OpenSeaPriceFetchError && error.retryable;
      const serverDelayMs =
        error instanceof OpenSeaPriceFetchError ? error.retryAfterMs : 0;
      if (
        !retryable ||
        attempt === MAX_ATTEMPTS ||
        serverDelayMs > MAX_RETRY_AFTER_MS
      ) {
        throw new OpenSeaPriceFetchError(
          `[OPENSEA] Request failed after ${attempt} attempt(s) for ${url}: ${errorMessage(error)}`,
          false,
          error
        );
      }

      const backoffMs = 1000 * 2 ** (attempt - 1);
      const delayMs = Math.max(
        serverDelayMs,
        backoffMs + Math.floor(Math.random() * backoffMs)
      );
      logger.warn(
        `[OPENSEA] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${url}: ${errorMessage(error)}. Retrying in ${delayMs}ms`
      );
      await waitForOpenSeaPage(delayMs, deadlineMs, url, error);
    }
  }
}
