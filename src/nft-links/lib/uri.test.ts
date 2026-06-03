import { normalizeIpfsUri } from './uri';

describe('normalizeIpfsUri', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';

  it('rewrites ipfs protocol urls to the 6529 IPFS gateway', () => {
    expect(normalizeIpfsUri(`ipfs://${cid}/image.png`)).toBe(
      `https://ipfs.6529.io/ipfs/${cid}/image.png`
    );
  });

  it('rewrites ipfs gateway urls to the 6529 IPFS gateway', () => {
    expect(normalizeIpfsUri(`https://ipfs.io/ipfs/${cid}/image.png`)).toBe(
      `https://ipfs.6529.io/ipfs/${cid}/image.png`
    );
  });

  it('rewrites bare IPFS CIDs to the 6529 IPFS gateway', () => {
    expect(normalizeIpfsUri(cid)).toBe(`https://ipfs.6529.io/ipfs/${cid}`);
  });

  it('preserves non-IPFS urls', () => {
    expect(normalizeIpfsUri('https://example.com/image.png')).toBe(
      'https://example.com/image.png'
    );
  });
});
