import {
  parseDecentralizedMediaRef,
  resolveDecentralizedMediaInputs,
  to6529ResolverUrl,
  toExternalFallbackUrls,
  toNativeUri
} from './decentralized-media';

describe('decentralized media resolver', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';
  const cidV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const txid = 'OI6-rpJ2C3Ab4HiZRWt5A1SumhjnYigmSPBPX0ICBj8';
  const dnsSafeTxid = txid.toLowerCase();

  it.each([
    [`ipfs://${cid}/image.png`, 'ipfs', cid, 'image.png'],
    [`ipfs://ipfs/${cid}/image.png`, 'ipfs', cid, 'image.png'],
    [
      `ipns://k51qzi5uqu5dl/example.json`,
      'ipns',
      'k51qzi5uqu5dl',
      'example.json'
    ],
    [`ar://${txid}/metadata.json`, 'arweave', txid, 'metadata.json'],
    [`https://media.6529.io/ipfs/${cid}/image.png`, 'ipfs', cid, 'image.png'],
    [
      `https://media.6529.io/ipns/k51qzi5uqu5dl/example.json`,
      'ipns',
      'k51qzi5uqu5dl',
      'example.json'
    ],
    [
      `https://media.6529.io/arweave/${txid}/metadata.json`,
      'arweave',
      txid,
      'metadata.json'
    ],
    [`https://ipfs.io/ipfs/${cid}/image.png`, 'ipfs', cid, 'image.png'],
    [
      `https://gateway.pinata.cloud/ipfs/${cidV1}/dir/image.png`,
      'ipfs',
      cidV1,
      'dir/image.png'
    ],
    [
      `https://${cidV1}.ipfs.nftstorage.link/dir/image.png`,
      'ipfs',
      cidV1,
      'dir/image.png'
    ],
    [
      `https://arweave.net/${txid}/metadata.json`,
      'arweave',
      txid,
      'metadata.json'
    ],
    [
      `https://${dnsSafeTxid}.ar.io/metadata.json`,
      'arweave',
      dnsSafeTxid,
      'metadata.json'
    ]
  ])('parses recognized input %s', (input, protocol, id, path) => {
    expect(parseDecentralizedMediaRef(input)).toEqual({
      protocol,
      id,
      path
    });
  });

  it('builds native, resolver, and fallback URLs from a parsed ref', () => {
    const ref = parseDecentralizedMediaRef(
      `https://ipfs.io/ipfs/${cidV1}/a/b.png`
    );
    expect(ref).toEqual({ protocol: 'ipfs', id: cidV1, path: 'a/b.png' });
    expect(toNativeUri(ref!)).toBe(`ipfs://${cidV1}/a/b.png`);
    expect(to6529ResolverUrl(ref!)).toBe(
      `https://media.6529.io/ipfs/${cidV1}/a/b.png`
    );
    expect(toExternalFallbackUrls(ref!)).toEqual(
      expect.arrayContaining([
        `https://ipfs.io/ipfs/${cidV1}/a/b.png`,
        `https://ipfs.6529.io/ipfs/${cidV1}/a/b.png`,
        `https://${cidV1}.ipfs.dweb.link/a/b.png`
      ])
    );
  });

  it('omits subdomain fallbacks for non-DNS-safe IPFS CIDs', () => {
    const ref = parseDecentralizedMediaRef(`ipfs://${cid}/a/b.png`);

    expect(toExternalFallbackUrls(ref!)).toEqual(
      expect.arrayContaining([
        `https://ipfs.io/ipfs/${cid}/a/b.png`,
        `https://ipfs.6529.io/ipfs/${cid}/a/b.png`
      ])
    );
    expect(toExternalFallbackUrls(ref!)).not.toEqual(
      expect.arrayContaining([`https://${cid}.ipfs.dweb.link/a/b.png`])
    );
  });

  it('returns Arweave gateway and tx-subdomain fallback URLs', () => {
    const ref = parseDecentralizedMediaRef(`ar://${dnsSafeTxid}/metadata.json`);
    expect(toExternalFallbackUrls(ref!)).toEqual(
      expect.arrayContaining([
        `https://arweave.net/${dnsSafeTxid}/metadata.json`,
        `https://gateway.arweave.net/${dnsSafeTxid}/metadata.json`,
        `https://gateway.ar.io/${dnsSafeTxid}/metadata.json`,
        `https://ar-io.net/${dnsSafeTxid}/metadata.json`,
        `https://ardrive.net/${dnsSafeTxid}/metadata.json`,
        `https://${dnsSafeTxid}.arweave.net/metadata.json`,
        `https://${dnsSafeTxid}.ar.io/metadata.json`
      ])
    );
  });

  it('omits subdomain fallbacks for non-DNS-safe Arweave txids', () => {
    const ref = parseDecentralizedMediaRef(`ar://${txid}/metadata.json`);

    expect(toExternalFallbackUrls(ref!)).toEqual(
      expect.arrayContaining([
        `https://arweave.net/${txid}/metadata.json`,
        `https://gateway.arweave.net/${txid}/metadata.json`
      ])
    );
    expect(toExternalFallbackUrls(ref!)).not.toEqual(
      expect.arrayContaining([`https://${txid}.arweave.net/metadata.json`])
    );
  });

  it('does not recognize invalid IPFS CIDs or Arweave txids', () => {
    expect(
      parseDecentralizedMediaRef('https://ipfs.io/ipfs/not-a-cid/a.png')
    ).toBeNull();
    expect(parseDecentralizedMediaRef('ipfs://not-a-cid/a.png')).toBeNull();
    expect(
      parseDecentralizedMediaRef('https://arweave.net/not-a-txid')
    ).toBeNull();
    expect(parseDecentralizedMediaRef('ar://not-a-txid')).toBeNull();
  });

  it('strips query strings and hashes from canonical forms with a warning', () => {
    const [resolution] = resolveDecentralizedMediaInputs([
      `https://ipfs.io/ipfs/${cid}/image.png?download=1#preview`
    ]);

    expect(resolution).toMatchObject({
      recognized: true,
      native_uri: `ipfs://${cid}/image.png`,
      resolver_url: `https://media.6529.io/ipfs/${cid}/image.png`,
      warnings: ['query_or_hash_stripped']
    });
  });

  it('returns item-level warnings for invalid URLs and preserves unrecognized HTTP URLs', () => {
    expect(
      resolveDecentralizedMediaInputs([
        'https://%zz',
        'https://example.com',
        '',
        '   '
      ])
    ).toEqual([
      {
        input: 'https://%zz',
        recognized: false,
        external_fallback_urls: [],
        warnings: ['invalid_url']
      },
      {
        input: 'https://example.com',
        recognized: false,
        external_fallback_urls: [],
        warnings: []
      },
      {
        input: '',
        recognized: false,
        external_fallback_urls: [],
        warnings: ['invalid_url']
      },
      {
        input: '   ',
        recognized: false,
        external_fallback_urls: [],
        warnings: ['invalid_url']
      }
    ]);
  });

  it('omits external fallbacks when requested', () => {
    const [resolution] = resolveDecentralizedMediaInputs([`ipfs://${cid}`], {
      includeExternalFallbacks: false
    });

    expect(resolution).toMatchObject({
      recognized: true,
      external_fallback_urls: []
    });
  });
});
