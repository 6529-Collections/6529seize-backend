import axios, { AxiosResponse } from 'axios';
import { ipfs } from './ipfs';

export class MediaChecker {
  public async getContentType(url: string): Promise<string | null> {
    try {
      const response: AxiosResponse = await axios.head(
        ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(url)
      );
      const cType = response.headers['content-type'];
      if (cType) {
        return cType.split('/')[1].toLowerCase();
      }
      return null;
    } catch (error) {
      try {
        const response: AxiosResponse = await axios.head(
          ipfs.ifIpfsThenIpfsIoElsePreserveOrEmptyIfUndefined(url)
        );
        const cType = response.headers['content-type'];
        if (cType) {
          return cType.split('/')[1].toLowerCase();
        }
        return null;
      } catch (error) {
        return null;
      }
    }
  }
}

export const mediaChecker = new MediaChecker();
