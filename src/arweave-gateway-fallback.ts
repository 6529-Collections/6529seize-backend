const ARWEAVE_GATEWAYS = [
  'arweave.net',
  'arweave.org',
  'g8way.io',
  'gateway.arweave.net'
] as const;

type ArweaveGateway = (typeof ARWEAVE_GATEWAYS)[number];

const ARWEAVE_HOSTS_PATTERN = ARWEAVE_GATEWAYS.map((g) =>
  g.replace(/\./g, String.raw`\.`)
).join('|');

// Capture:
// 1 = host
// 2 = path (including leading /), default "/"
// 3 = query (including leading ?), optional
const ARWEAVE_URL_RE = new RegExp(
  String.raw`^https?:\/\/(?:www\.)?(${ARWEAVE_HOSTS_PATTERN})(\/[^#?]*)?(\?[^#]*)?`
);

function parseArweaveUrl(
  url: string
): { host: ArweaveGateway; pathAndQuery: string } | null {
  const match = ARWEAVE_URL_RE.exec(url);
  if (!match) return null;

  const host = match[1] as ArweaveGateway;
  const path = match[2] ?? '/';
  const query = match[3] ?? '';
  return { host, pathAndQuery: `${path}${query}` };
}

export function getArweaveFallbackUrls(url: string): string[] {
  const parsed = parseArweaveUrl(url);
  if (!parsed) return [];
  return ARWEAVE_GATEWAYS.map(
    (host) => `https://${host}${parsed.pathAndQuery}`
  );
}

export function getArweaveFallbackUrl(url: string): string | null {
  const parsed = parseArweaveUrl(url);
  if (!parsed) return null;

  const idx = ARWEAVE_GATEWAYS.indexOf(parsed.host);
  if (idx < 0)
    return ARWEAVE_GATEWAYS[0]
      ? `https://${ARWEAVE_GATEWAYS[0]}${parsed.pathAndQuery}`
      : null;
  if (idx >= ARWEAVE_GATEWAYS.length - 1) return null;

  const next = ARWEAVE_GATEWAYS[idx + 1];
  return next ? `https://${next}${parsed.pathAndQuery}` : null;
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
