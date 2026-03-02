const ARWEAVE_URL_RE = /^https?:\/\/(?:www\.)?arweave\.net\/([^/?#]+)/;

export function getArweaveFallbackUrl(url: string): string | null {
  const match = url.match(ARWEAVE_URL_RE);
  return match ? `https://ar-io.net/${match[1]}` : null;
}

export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string) => Promise<T>
): Promise<T> {
  try {
    return await fetchFn(url);
  } catch (err) {
    const fallback = getArweaveFallbackUrl(url);
    if (fallback) {
      return await fetchFn(fallback);
    }
    throw err;
  }
}
