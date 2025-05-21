export class Ipfs {
  public ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(
    url: string | undefined
  ): string {
    if (!url) {
      return '';
    }
    const cid = this.extractIpfsCidFromUrlOrEmpty(url);
    if (cid !== '') {
      return `https://cf-ipfs.com/ipfs/${cid}`;
    }
    return url;
  }

  public ifIpfsThenIpfsIoElsePreserveOrEmptyIfUndefined(
    url: string | undefined
  ): string {
    if (!url) {
      return '';
    }
    const cid = this.extractIpfsCidFromUrlOrEmpty(url);
    if (cid !== '') {
      return `https://ipfs.io/ipfs/${cid}`;
    }
    return url;
  }

  private extractIpfsCidFromUrlOrEmpty(url: string | undefined) {
    if (url?.startsWith('ipfs')) {
      return url.split('://')[1] ?? '';
    }
    return url ?? '';
  }
}

export const ipfs = new Ipfs();
