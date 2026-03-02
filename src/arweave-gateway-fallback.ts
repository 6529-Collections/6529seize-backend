const ARWEAVE_GATEWAYS: readonly string[] = [
  'arweave.net',
  'arweave.org',
  'arweave.dev',
  'ar-io.net',
  'arweave.live',
  'gateway.arweave.io',
  'arweave.surf',
  'arweave.team',
  'arweavetoday.com',
  'arweave.fyi',
  'arweave.guide'
] as const;

const ARWEAVE_URL_RE = new RegExp(
  `^https?:\\/\\/(?:www\\.)?(${ARWEAVE_GATEWAYS.map((g) => g.replace(/\./g, '\\.')).join('|')})\\/([^/?#]+)`
);

export function getArweaveFallbackUrls(url: string): string[] {
  const match = ARWEAVE_URL_RE.exec(url);
  if (!match) return [];
  const path = match[2];
  return ARWEAVE_GATEWAYS.map((host) => `https://${host}/${path}`);
}

export function getArweaveFallbackUrl(url: string): string | null {
  const urls = getArweaveFallbackUrls(url);
  const match = ARWEAVE_URL_RE.exec(url);
  if (!match || urls.length < 2) return null;
  const currentHost = match[1];
  const idx = ARWEAVE_GATEWAYS.indexOf(currentHost);
  const nextIdx = idx < 0 ? 1 : Math.min(idx + 1, urls.length - 1);
  return urls[nextIdx] ?? null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string) => Promise<T>
): Promise<T> {
  const urls = getArweaveFallbackUrls(url);
  const toTry = urls.length > 0 ? urls : [url];
  let lastErr: unknown;
  for (const tryUrl of toTry) {
    try {
      return await fetchFn(tryUrl);
    } catch (err) {
      lastErr = err;
    }
  }
  const msg =
    toTry.length > 1
      ? `Arweave: all ${toTry.length} gateways failed. Last: ${stringifyErr(lastErr)}`
      : stringifyErr(lastErr);
  throw Object.assign(new Error(msg), { cause: lastErr });
}
