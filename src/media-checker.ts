import { getDecentralizedMediaFetchUrls } from '@/decentralized-media/decentralized-media';
import axios, { AxiosResponse } from 'axios';

export class MediaChecker {
  public async getContentType(url: string): Promise<string | null> {
    const urls = getDecentralizedMediaFetchUrls(url, {
      includeExternalFallbacks: true
    });

    for (const currentUrl of urls) {
      try {
        const response: AxiosResponse = await axios.head(currentUrl);
        const cType = response.headers['content-type'];
        if (typeof cType === 'string') {
          return cType.split('/')[1]?.toLowerCase() ?? null;
        }
        return null;
      } catch {
        // Try the next decentralized fallback, if any.
      }
    }

    return null;
  }
}

export const mediaChecker = new MediaChecker();
