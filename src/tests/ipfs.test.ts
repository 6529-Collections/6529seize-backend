import { ipfs } from '../ipfs';

describe('ipfs', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';

  it('rewrites ipfs:// urls to the 6529 media resolver', () => {
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(`ipfs://${cid}`)
    ).toBe(`https://media.6529.io/ipfs/${cid}`);
  });

  it('rewrites /ipfs/<cid> gateway urls to the 6529 media resolver', () => {
    expect(
      ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(
        `https://ipfs.io/ipfs/${cid}/metadata.json`
      )
    ).toBe(`https://media.6529.io/ipfs/${cid}/metadata.json`);
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
