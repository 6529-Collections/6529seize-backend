import { getDecentralizedMediaFetchUrls } from '@/decentralized-media/decentralized-media';
import { publicFetch } from '@/http/public-fetch';
import { Time } from '@/time';

const CONTENT_TYPE_PROBE_TIMEOUT_MS = Time.seconds(5).toMillis();
const CONTENT_TYPE_PROBE_MAX_REDIRECTS = 5;

export class MediaChecker {
  public async getContentType(url: string): Promise<string | null> {
    const urls = getDecentralizedMediaFetchUrls(url, {
      includeExternalFallbacks: true
    });

    for (const currentUrl of urls) {
      try {
        const response = await publicFetch(currentUrl, {
          method: 'HEAD',
          maxBytes: 0,
          maxRedirects: CONTENT_TYPE_PROBE_MAX_REDIRECTS,
          timeoutMs: CONTENT_TYPE_PROBE_TIMEOUT_MS
        });
        const cType = response.ok ? response.headers.get('content-type') : null;
        if (typeof cType === 'string') {
          return cType.split('/')[1]?.toLowerCase() ?? null;
        }
        continue;
      } catch {
        // Try the next decentralized fallback, if any.
      }
    }

    return null;
  }
}

export const mediaChecker = new MediaChecker();
