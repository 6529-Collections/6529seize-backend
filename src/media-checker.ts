import { getDecentralizedMediaFetchUrls } from '@/decentralized-media/decentralized-media';
import { Time } from '@/time';
import axios, { AxiosResponse } from 'axios';

const CONTENT_TYPE_PROBE_TIMEOUT_MS = Time.seconds(5).toMillis();

export class MediaChecker {
  public async getContentType(url: string): Promise<string | null> {
    const urls = getDecentralizedMediaFetchUrls(url, {
      includeExternalFallbacks: true
    });

    for (const currentUrl of urls) {
      try {
        const response: AxiosResponse = await axios.head(currentUrl, {
          timeout: CONTENT_TYPE_PROBE_TIMEOUT_MS
        });
        const cType = response.headers['content-type'];
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
