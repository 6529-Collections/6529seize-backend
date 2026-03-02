const ARWEAVE_URL_RE = /^https?:\/\/(?:www\.)?arweave\.net\/([^/?#]+)/;

export function getArweaveFallbackUrl(url: string): string | null {
  const match = ARWEAVE_URL_RE.exec(url);
  return match ? `https://ar-io.net/${match[1]}` : null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string) => Promise<T>
): Promise<T> {
  try {
    return await fetchFn(url);
  } catch (originalErr) {
    const fallback = getArweaveFallbackUrl(url);
    if (fallback) {
      try {
        return await fetchFn(fallback);
      } catch (fallbackErr) {
        const msg = `Arweave gateway and fallback failed. Original: ${stringifyErr(originalErr)}; Fallback: ${stringifyErr(fallbackErr)}`;
        throw Object.assign(new Error(msg), {
          cause: fallbackErr,
          originalError: originalErr
        });
      }
    }
    throw originalErr;
  }
}
