import { normalizeIpfsUri } from './uri';

describe('normalizeIpfsUri', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';
  const cidV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  it('rewrites ipfs protocol urls to the 6529 IPFS gateway', () => {
    expect(normalizeIpfsUri(`ipfs://${cid}/image.png`)).toBe(
      `https://ipfs.6529.io/ipfs/${cid}/image.png`
    );
  });

  it('normalizes ipfs protocol urls with an ipfs path segment', () => {
    expect(normalizeIpfsUri(`ipfs://ipfs/${cid}/image.png`)).toBe(
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

  it('rewrites bare CIDv1 values to the 6529 IPFS gateway', () => {
    expect(normalizeIpfsUri(cidV1)).toBe(`https://ipfs.6529.io/ipfs/${cidV1}`);
  });

  it('preserves non-gateway urls that contain an ipfs path segment', () => {
    expect(normalizeIpfsUri('https://example.com/path/ipfs/data')).toBe(
      'https://example.com/path/ipfs/data'
    );
  });

  it('preserves non-gateway urls that contain an ipfs-like path segment', () => {
    expect(normalizeIpfsUri('https://example.com/my-ipfs/data.json')).toBe(
      'https://example.com/my-ipfs/data.json'
    );
  });

  it('preserves non-IPFS urls', () => {
    expect(normalizeIpfsUri('https://example.com/image.png')).toBe(
      'https://example.com/image.png'
    );
  });
});
