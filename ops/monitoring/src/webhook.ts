import type { DeliveryErrorDetails } from './dispatch-diagnostics.js';

export class DeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds = 0,
    readonly deferred = false,
    readonly details?: DeliveryErrorDetails
  ) {
    super(retryable ? 'WEBHOOK_RETRYABLE' : 'WEBHOOK_PERMANENT');
  }
}
export function webhookUrl(secret: string): string {
  let url: URL;
  try {
    url = new URL(secret.trim());
  } catch {
    throw new DeliveryError(false, 0, false, {
      cause: 'INVALID_DELIVERY_CONFIGURATION'
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new DeliveryError(false, 0, false, {
      cause: 'INVALID_DELIVERY_CONFIGURATION'
    });
  }
  url.search = '?wait=true';
  url.hash = '';
  return url.toString();
}
export async function deliver(
  secret: string,
  payload: object,
  send: typeof fetch = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await send(webhookUrl(secret), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(true, 0, false, { cause: transportCause(error) });
  }
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const body = (await response.json().catch(() => ({}))) as {
      retry_after?: unknown;
    };
    const delay = Number(body.retry_after ?? header ?? Number.NaN);
    throw new DeliveryError(
      true,
      Number.isFinite(delay)
        ? Math.min(43200, Math.max(1, Math.ceil(delay)))
        : 60,
      false,
      { cause: 'HTTP_RATE_LIMIT', httpStatus: 429 }
    );
  }
  if (!response.ok)
    throw new DeliveryError(
      response.status >= 500 || response.status === 408,
      0,
      false,
      {
        cause:
          response.status >= 500 || response.status === 408
            ? 'HTTP_RETRYABLE_STATUS'
            : 'HTTP_PERMANENT_STATUS',
        httpStatus: response.status
      }
    );
  const result = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  if (!result || typeof result.id !== 'string' || !/^\d+$/.test(result.id)) {
    throw new DeliveryError(true, 0, false, {
      cause: 'INVALID_DELIVERY_RESPONSE',
      httpStatus: response.status
    });
  }
  return result.id;
}

function transportCause(error: unknown): DeliveryErrorDetails['cause'] {
  try {
    // Only standard timeout identity is inspected; arbitrary messages and getters are ignored.
    if (
      error instanceof DOMException &&
      Object.getOwnPropertyDescriptor(
        DOMException.prototype,
        'name'
      )?.get?.call(error) === 'TimeoutError'
    )
      return 'TRANSPORT_TIMEOUT';
    const descriptor =
      error !== null && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'name')
        : undefined;
    if (
      descriptor &&
      'value' in descriptor &&
      descriptor.value === 'TimeoutError'
    )
      return 'TRANSPORT_TIMEOUT';
  } catch {
    /* Unknown transport errors stay opaque. */
  }
  return 'TRANSPORT_OTHER';
}
