import {
  parseDecentralizedMediaRef,
  toExternalFallbackUrls
} from '@/decentralized-media/decentralized-media';

function dedupe(list: readonly string[]): string[] {
  return Array.from(new Set(list));
}

/**
 * Returns all external Arweave gateway variants for the given URL.
 */
export function getArweaveFallbackUrls(url: string): string[] {
  const ref = parseDecentralizedMediaRef(url);
  if (ref?.protocol !== 'arweave') return [];

  return toExternalFallbackUrls(ref);
}

/**
 * Returns the next Arweave gateway URL after the current URL.
 * If the current URL is not itself one of the external fallbacks, returns the
 * first external fallback.
 */
export function getArweaveFallbackUrl(url: string): string | null {
  const urls = getArweaveFallbackUrls(url);
  if (urls.length < 1) return null;

  const currentIndex = urls.indexOf(stripQueryAndHash(url));
  if (currentIndex < 0) return urls[0] ?? null;
  if (currentIndex >= urls.length - 1) return null;

  return urls[currentIndex + 1] ?? null;
}

function stripQueryAndHash(url: string): string {
  return url.replace(/[?#].*$/, '');
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tries the URL first, then external Arweave fallbacks in order.
 * If url is not a recognized Arweave reference, it just tries url once.
 */
export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string) => Promise<T>
): Promise<T> {
  const urls = getArweaveFallbackUrls(url);
  const toTry = urls.length > 0 ? [url, ...urls] : [url];
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
      ? `Arweave: all ${uniqueToTry.length} URLs failed. Last: ${stringifyErr(
          lastErr
        )}`
      : stringifyErr(lastErr);

  throw Object.assign(new Error(msg), { cause: lastErr });
}
