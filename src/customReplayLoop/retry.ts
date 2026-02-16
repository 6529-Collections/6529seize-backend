import pLimit from 'p-limit';

// Use a very high concurrency to avoid changing behavior. Adjust if needed elsewhere.
const __retryLimiter = pLimit(Number.MAX_SAFE_INTEGER);

// retry.ts
export type RetryOptions = {
  attempts?: number; // total attempts (including the first). default 3
  minDelayMs?: number; // base backoff. default 500ms
  maxDelayMs?: number; // cap on backoff. default 8000ms
  onRetry?: (err: any, attempt: number) => void;
  isRetriable?: (err: any) => boolean;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = 10,
    minDelayMs = 1000,
    maxDelayMs = 15000,
    onRetry,
    isRetriable = defaultIsRetriable
  }: RetryOptions = {}
): Promise<T> {
  return __retryLimiter(async () => {
    let attempt = 0;
    let lastErr: any;
    while (attempt < attempts) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        attempt++;
        const willRetry = attempt < attempts && isRetriable(err);
        if (!willRetry) break;

        // exponential backoff with jitter
        const backoff = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * Math.floor(backoff / 3));
        const delay = backoff + jitter;

        onRetry?.(err, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  });
}

// A conservative "transient" detector tailored for ethers/web + HTTP-ish failures
function defaultIsRetriable(err: any): boolean {
  if (!err) return false;

  // ethers v5 style
  if (err.code === 'SERVER_ERROR') return true;
  if (err.code === 'NETWORK_ERROR') return true;
  if (err.reason && /timeout/i.test(String(err.reason))) return true;

  // common Node errors
  const code = (err.code || '').toString();
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN'
    ].includes(code)
  ) {
    return true;
  }

  // Alchemy/HTTP response payloads often include status-like hints
  const status = Number(err.status || err.statusCode);
  if (status) {
    if (status === 429) return true; // rate limited
    if (status >= 500 && status < 600) return true; // upstream hiccup
  }

  // Some providers wrap the JSON-RPC body in err.requestBody or message
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('failed response')) return true;
  if (msg.includes('gateway') && msg.includes('timeout')) return true;

  return false;
}
