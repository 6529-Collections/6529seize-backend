import { normalizeIpfsUri } from '@/nft-links/lib/uri';

export class Ipfs {
  public ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(
    url: string | undefined
  ): string {
    return this.ifIpfsThen6529ResolverElsePreserveOrEmptyIfUndefined(url);
  }

  public ifIpfsThenIpfsIoElsePreserveOrEmptyIfUndefined(
    url: string | undefined
  ): string {
    return this.ifIpfsThen6529ResolverElsePreserveOrEmptyIfUndefined(url);
  }

  private ifIpfsThen6529ResolverElsePreserveOrEmptyIfUndefined(
    url: string | undefined
  ): string {
    if (!url) {
      return '';
    }
    return normalizeIpfsUri(url) ?? '';
  }
}

export const ipfs = new Ipfs();
