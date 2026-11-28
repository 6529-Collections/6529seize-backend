import { withArweaveFallback } from '@/arweave-gateway-fallback';
import {
  parseDecentralizedMediaRef,
  getDecentralizedMediaFetchUrls
} from '@/decentralized-media/decentralized-media';
import { publicFetch } from '@/http/public-fetch';
import { Time } from '@/time';

const CONTENT_TYPE_PROBE_TIMEOUT_MS = Time.seconds(5).toMillis();
const CONTENT_TYPE_PROBE_MAX_REDIRECTS = 5;

export class MediaChecker {
  public async getContentType(url: string): Promise<string | null> {
    if (parseDecentralizedMediaRef(url)?.protocol === 'arweave') {
      try {
        return await withArweaveFallback(
          url,
          async (candidate, signal) => {
            const response = await publicFetch(candidate, {
              method: 'HEAD',
              signal,
              maxBytes: 0,
              maxRedirects: CONTENT_TYPE_PROBE_MAX_REDIRECTS,
              timeoutMs: CONTENT_TYPE_PROBE_TIMEOUT_MS
            });
            const contentType = response.ok
              ? response.headers.get('content-type')
              : null;
            if (!contentType)
              throw new Error('Arweave content type unavailable');
            return contentType.split('/')[1]?.toLowerCase() ?? null;
          },
          { timeoutMs: CONTENT_TYPE_PROBE_TIMEOUT_MS, attemptTimeoutMs: 1500 }
        );
      } catch {
        return null;
      }
    }
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
