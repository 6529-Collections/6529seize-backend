const ARWEAVE_GATEWAYS_PRIORITY: readonly string[] = [
  'arweave.net',
  'gateway.arweave.net',
  'g8way.io'
] as const;

const ARWEAVE_GATEWAYS_LONG_TAIL: readonly string[] = [
  'arweave.org',
  'arweave.dev',
  'ar-io.net',
  'arweave.live',
  'arweave.surf',
  'arweave.team',
  'arweavetoday.com',
  'arweave.fyi',
  'arweave.guide'
] as const;

const ARWEAVE_GATEWAYS: readonly string[] = dedupe([
  ...ARWEAVE_GATEWAYS_PRIORITY,
  ...ARWEAVE_GATEWAYS_LONG_TAIL
]);

function dedupe(list: readonly string[]): string[] {
  return Array.from(new Set(list));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ARWEAVE_HOSTS_PATTERN = ARWEAVE_GATEWAYS.map(escapeRegex).join('|');

/**
 * Capture:
 *  1) host (without www.)
 *  2) path (starting with /), optional
 *  3) query (starting with ?), optional
 * Ignores hash fragment.
 */
const ARWEAVE_URL_RE = new RegExp(
  String.raw`^https?:\/\/(?:www\.)?(${ARWEAVE_HOSTS_PATTERN})(\/[^#?]*)?(\?[^#]*)?`,
  'i'
);

function parseArweaveUrl(url: string): { host: string; suffix: string } | null {
  const match = ARWEAVE_URL_RE.exec(url);
  if (!match?.[1]) return null;

  const host = match[1].toLowerCase();
  const path = match[2] ?? '/';
  const query = match[3] ?? '';

  return { host, suffix: `${path}${query}` };
}

/**
 * Returns all gateway variants for the given URL (in priority order),
 * preserving full path and query string.
 */
export function getArweaveFallbackUrls(url: string): string[] {
  const parsed = parseArweaveUrl(url);
  if (!parsed) return [];

  return ARWEAVE_GATEWAYS.map((host) => `https://${host}${parsed.suffix}`);
}

/**
 * Returns the “next” gateway URL after the current URL’s host.
 * If current host isn’t in the list, returns the first gateway URL.
 * If current host is the last, returns null.
 */
export function getArweaveFallbackUrl(url: string): string | null {
  const parsed = parseArweaveUrl(url);
  if (!parsed) return null;

  const urls = ARWEAVE_GATEWAYS.map(
    (host) => `https://${host}${parsed.suffix}`
  );
  if (urls.length < 2) return null;

  const idx = ARWEAVE_GATEWAYS.indexOf(parsed.host);

  if (idx < 0) return urls[0] ?? null;
  if (idx >= urls.length - 1) return null;

  return urls[idx + 1] ?? null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tries the URL across gateways in order until fetchFn succeeds.
 * If url isn’t a recognised gateway URL, it just tries url once.
 */
export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string) => Promise<T>
): Promise<T> {
  const urls = getArweaveFallbackUrls(url);

  // If the URL is an Arweave gateway URL, try all gateway variants.
  // Otherwise, just try the URL as-is.
  const toTry = urls.length > 0 ? urls : [url];

  // Optional: avoid trying the exact same string twice
  const uniqueToTry = dedupe(toTry);

  let lastErr: unknown;
  for (const tryUrl of uniqueToTry) {
    try {
      return await fetchFn(tryUrl);
    } catch (err) {
      lastErr = err;
    }
  }

  const msg =
    uniqueToTry.length > 1
      ? `Arweave: all ${uniqueToTry.length} gateways failed. Last: ${stringifyErr(lastErr)}`
      : stringifyErr(lastErr);

  throw Object.assign(new Error(msg), { cause: lastErr });
}
