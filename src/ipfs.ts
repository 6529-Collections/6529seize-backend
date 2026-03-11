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
    if (!url) {
      return '';
    }

    const trimmed = url.trim();
    if (!trimmed) {
      return '';
    }

    const ipfsProtocolMatch = /^ipfs:\/\/(.+)$/i.exec(trimmed);
    if (ipfsProtocolMatch) {
      return this.normalizeIpfsPathToCid(ipfsProtocolMatch[1]);
    }

    const ipfsPathMatch = /\/ipfs\/([^/?#]+)/i.exec(trimmed);
    if (ipfsPathMatch) {
      return ipfsPathMatch[1];
    }

    if (this.looksLikeIpfsCid(trimmed)) {
      return trimmed;
    }

    return '';
  }

  private normalizeIpfsPathToCid(path: string): string {
    const withoutLeadingIpfsSegment = path
      .replace(/^\/+/, '')
      .replace(/^ipfs\//i, '');
    return withoutLeadingIpfsSegment.split(/[/?#]/)[0] ?? '';
  }

  private looksLikeIpfsCid(value: string): boolean {
    return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|[bB][aA][fF][a-zA-Z2-7]{20,})$/.test(
      value
    );
  }
}

export const ipfs = new Ipfs();
