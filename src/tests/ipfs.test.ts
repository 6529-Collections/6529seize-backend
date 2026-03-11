import { ipfs } from '../ipfs';

describe('ipfs', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';

  it('rewrites ipfs:// urls to Cloudflare IPFS gateway', () => {
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(`ipfs://${cid}`)
    ).toBe(`https://cf-ipfs.com/ipfs/${cid}`);
  });

  it('rewrites /ipfs/<cid> gateway urls to Cloudflare IPFS gateway', () => {
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(
        `https://ipfs.io/ipfs/${cid}/metadata.json`
      )
    ).toBe(`https://cf-ipfs.com/ipfs/${cid}`);
  });

  it('preserves arweave urls', () => {
    const arweaveUrl =
      'https://arweave.net/_MSzxiISR3AgFJqhzBoAbCtFGMglSqRmZi5NTgZLfL4';
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(arweaveUrl)
    ).toBe(arweaveUrl);
    expect(
      ipfs.ifIpfsThenIpfsIoElsePreserveOrEmptyIfUndefined(arweaveUrl)
    ).toBe(arweaveUrl);
  });

  it('preserves non-ipfs urls', () => {
    const regularUrl = 'https://example.com/image.png';
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(regularUrl)
    ).toBe(regularUrl);
  });
});
