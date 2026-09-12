export class DeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds = 0,
    readonly deferred = false
  ) {
    super(retryable ? 'WEBHOOK_RETRYABLE' : 'WEBHOOK_PERMANENT');
  }
}
export function webhookUrl(secret: string): string {
  let url: URL;
  try {
    url = new URL(secret.trim());
  } catch {
    throw new DeliveryError(false);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new DeliveryError(false);
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
    throw new DeliveryError(true);
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
        : 60
    );
  }
  if (!response.ok)
    throw new DeliveryError(response.status >= 500 || response.status === 408);
  const result = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  if (!result || typeof result.id !== 'string' || !/^\d+$/.test(result.id)) {
    throw new DeliveryError(true);
  }
  return result.id;
}
