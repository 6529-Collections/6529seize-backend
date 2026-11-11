import fc from 'fast-check';
import {
  getDecentralizedMediaFetchUrls,
  getMediaResolverOrigin,
  isFirstPartyMediaGatewayUrl,
  normalizeDecentralizedMediaUri,
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

  it('does not recognize nested IPFS gateway prefixes', () => {
    expect(
      parseDecentralizedMediaRef(`https://ipfs.io/foo/ipfs/${cid}/image.png`)
    ).toBeNull();
    expect(
      parseDecentralizedMediaRef(
        `https://ipfs.io/foo/ipns/k51qzi5uqu5dl/example.json`
      )
    ).toBeNull();
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

describe('separate content domain for user media', () => {
  const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';
  const cidV1 = 'bafybeieu3ufszpka5nyzhlcrf5cceiy6n3ug6fdx7chbntxvmf2p32ryhe';
  const otherCidV1 =
    'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const rawCidV1 =
    'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
  const txid = 'OI6-rpJ2C3Ab4HiZRWt5A1SumhjnYigmSPBPX0ICBj8';
  const ENV = 'MEDIA_RESOLVER_ENDPOINT';
  const OLD = 'https://media.6529.io';
  const NEW = 'https://media.6529usercontent.com';
  const originalValue = process.env[ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = originalValue;
    }
  });

  function outputsFor(input: string) {
    const ref = parseDecentralizedMediaRef(input)!;
    return {
      resolver: to6529ResolverUrl(ref),
      fallbacks: toExternalFallbackUrls(ref),
      normalized: normalizeDecentralizedMediaUri(input),
      fetchUrls: getDecentralizedMediaFetchUrls(input),
      resolution: resolveDecentralizedMediaInputs([input])[0]
    };
  }

  describe('output', () => {
    it.each([undefined, '', '   ', OLD, `${OLD}/`])(
      'keeps the current URLs when the endpoint is %p',
      (value) => {
        if (value === undefined) {
          delete process.env[ENV];
        } else {
          process.env[ENV] = value;
        }
        expect(getMediaResolverOrigin()).toBe(OLD);

        const ipfs = outputsFor(`ipfs://${cid}/a/b.png`);
        expect(ipfs.resolver).toBe(`${OLD}/ipfs/${cid}/a/b.png`);
        expect(ipfs.normalized).toBe(`${OLD}/ipfs/${cid}/a/b.png`);
        expect(ipfs.fetchUrls[0]).toBe(`${OLD}/ipfs/${cid}/a/b.png`);
        expect(ipfs.resolution.resolver_url).toBe(`${OLD}/ipfs/${cid}/a/b.png`);
        expect(ipfs.fallbacks).toEqual([
          `https://ipfs.io/ipfs/${cid}/a/b.png`,
          `https://cf-ipfs.com/ipfs/${cid}/a/b.png`,
          `https://cloudflare-ipfs.com/ipfs/${cid}/a/b.png`,
          `https://gateway.pinata.cloud/ipfs/${cid}/a/b.png`,
          `https://ipfs.6529.io/ipfs/${cid}/a/b.png`
        ]);
        expect(ipfs.resolution.external_fallback_urls).toEqual(ipfs.fallbacks);
        expect(outputsFor(`ar://${txid}`).resolver).toBe(
          `${OLD}/arweave/${txid}`
        );
        expect(outputsFor('ipns://k51qzi5uqu5dl/x.json').resolver).toBe(
          `${OLD}/ipns/k51qzi5uqu5dl/x.json`
        );
      }
    );

    it.each([
      'http://media.6529usercontent.com',
      'https://media.6529usercontent.com:8443',
      'https://media.6529usercontent.com/ipfs',
      'https://media.6529usercontent.com?x=1',
      'https://user@media.6529usercontent.com',
      'https://media.6529usercontent.com.example.com',
      'https://example.com',
      'https://ipfs.6529.io',
      'not a url'
    ])(
      'falls back to the current host for the unsupported endpoint %p',
      (value) => {
        process.env[ENV] = value;
        expect(getMediaResolverOrigin()).toBe(OLD);
        expect(outputsFor(`ipfs://${cid}`).resolver).toBe(`${OLD}/ipfs/${cid}`);
      }
    );

    it.each([NEW, `${NEW}/`, `  ${NEW}  `])(
      'builds content-domain path gateway URLs when the endpoint is %p',
      (value) => {
        process.env[ENV] = value;
        expect(getMediaResolverOrigin()).toBe(NEW);

        const ipfs = outputsFor(`https://ipfs.io/ipfs/${cid}/a/b.png`);
        expect(ipfs.resolver).toBe(`${NEW}/ipfs/${cid}/a/b.png`);
        expect(ipfs.normalized).toBe(`${NEW}/ipfs/${cid}/a/b.png`);
        expect(ipfs.fetchUrls[0]).toBe(`${NEW}/ipfs/${cid}/a/b.png`);
        expect(ipfs.resolution.resolver_url).toBe(`${NEW}/ipfs/${cid}/a/b.png`);
        expect(ipfs.fallbacks).toEqual([
          `https://ipfs.io/ipfs/${cid}/a/b.png`,
          `https://cf-ipfs.com/ipfs/${cid}/a/b.png`,
          `https://cloudflare-ipfs.com/ipfs/${cid}/a/b.png`,
          `https://gateway.pinata.cloud/ipfs/${cid}/a/b.png`
        ]);
        expect(ipfs.resolution.external_fallback_urls).toEqual(ipfs.fallbacks);
        expect(outputsFor(`ar://${txid}/m.json`).resolver).toBe(
          `${NEW}/arweave/${txid}/m.json`
        );
        expect(outputsFor('ipns://k51qzi5uqu5dl/x.json').resolver).toBe(
          `${NEW}/ipns/k51qzi5uqu5dl/x.json`
        );
        // Never a per-CID host.
        expect(outputsFor(`ipfs://${cidV1}/index.html`).resolver).toBe(
          `${NEW}/ipfs/${cidV1}/index.html`
        );
      }
    );

    it('lets an explicit resolver origin win over the configured one', () => {
      process.env[ENV] = NEW;
      const ref = parseDecentralizedMediaRef(`ipfs://${cid}`)!;
      expect(to6529ResolverUrl(ref, OLD)).toBe(`${OLD}/ipfs/${cid}`);
      expect(
        resolveDecentralizedMediaInputs([`ipfs://${cid}`], {
          resolverOrigin: OLD
        })[0].external_fallback_urls
      ).toContain(`https://ipfs.6529.io/ipfs/${cid}`);
    });
  });

  describe('input', () => {
    it.each([
      [`${NEW}/ipfs/${cid}/image.png`, 'ipfs', cid, 'image.png'],
      [`${NEW}/ipfs/${cidV1}`, 'ipfs', cidV1, ''],
      [`${NEW}/ipns/k51qzi5uqu5dl/x.json`, 'ipns', 'k51qzi5uqu5dl', 'x.json'],
      [`${NEW}/arweave/${txid}/m.json`, 'arweave', txid, 'm.json'],
      [`https://MEDIA.6529USERCONTENT.COM/ipfs/${cid}`, 'ipfs', cid, ''],
      [`https://${cidV1}.ipfs.6529usercontent.com/`, 'ipfs', cidV1, ''],
      [
        `https://${cidV1}.ipfs.6529usercontent.com/dir/index.html`,
        'ipfs',
        cidV1,
        'dir/index.html'
      ],
      [
        `https://${rawCidV1}.ipfs.6529usercontent.com/x.png`,
        'ipfs',
        rawCidV1,
        'x.png'
      ],
      [
        `https://${cidV1.toUpperCase()}.IPFS.6529usercontent.com/a.png`,
        'ipfs',
        cidV1,
        'a.png'
      ],
      [
        `https://${cidV1}.ipfs.6529usercontent.com/ipfs/${otherCidV1}/a.png`,
        'ipfs',
        otherCidV1,
        'a.png'
      ]
    ])('parses %s', (input, protocol, id, path) => {
      expect(parseDecentralizedMediaRef(input)).toEqual({ protocol, id, path });
    });

    it('parses a per-CID host to the same reference as its path URL', () => {
      for (const path of ['', 'index.html', 'dir/a%20b.png']) {
        const perCid = parseDecentralizedMediaRef(
          `https://${cidV1}.ipfs.6529usercontent.com/${path}`
        );
        expect(perCid).not.toBeNull();
        expect(perCid).toEqual(
          parseDecentralizedMediaRef(`${NEW}/ipfs/${cidV1}/${path}`)
        );
        expect(perCid).toEqual(
          parseDecentralizedMediaRef(`${OLD}/ipfs/${cidV1}/${path}`)
        );
      }
    });

    it('matches the nested ipfs segment on a per-CID host exactly', () => {
      const host = `https://${cidV1}.ipfs.6529usercontent.com`;
      expect(
        parseDecentralizedMediaRef(`${host}/ipfs/${otherCidV1}/x`)
      ).toEqual({ protocol: 'ipfs', id: otherCidV1, path: 'x' });
      expect(
        parseDecentralizedMediaRef(`${host}/IPFS/${otherCidV1}/x`)
      ).toEqual({ protocol: 'ipfs', id: cidV1, path: `IPFS/${otherCidV1}/x` });
      expect(
        parseDecentralizedMediaRef(`${host}/Ipfs/${otherCidV1}/x`)
      ).toEqual({ protocol: 'ipfs', id: cidV1, path: `Ipfs/${otherCidV1}/x` });
    });

    it('parses old and new path gateway URLs to the same reference', () => {
      for (const suffix of [
        `ipfs/${cid}/a.png`,
        'ipns/k51qzi5uqu5dl/x.json',
        `arweave/${txid}/m.json`
      ]) {
        expect(parseDecentralizedMediaRef(`${NEW}/${suffix}`)).toEqual(
          parseDecentralizedMediaRef(`${OLD}/${suffix}`)
        );
      }
    });

    it.each([
      `http://media.6529usercontent.com/ipfs/${cid}`,
      `https://media.6529usercontent.com:444/ipfs/${cid}`,
      `https://user@media.6529usercontent.com/ipfs/${cid}`,
      `https://media.6529usercontent.com.evil.example/ipfs/${cid}`,
      `https://evil.6529usercontent.com/ipfs/${cid}`,
      `https://6529usercontent.com/ipfs/${cid}`,
      `https://xmedia.6529usercontent.com/ipfs/${cid}`,
      `https://media.6529usercontent.com/s3/${cid}`,
      `https://media.6529usercontent.com/ipfs/not-a-cid`,
      `https://a.b.ipfs.6529usercontent.com/x.png`,
      `https://a.${cidV1}.ipfs.6529usercontent.com/x.png`,
      `https://ipfs.6529usercontent.com/x.png`,
      `https://media.ipfs.6529usercontent.com/ipfs/${cid}`,
      `https://${cid}.ipfs.6529usercontent.com/x.png`,
      `https://${cid.toLowerCase()}.ipfs.6529usercontent.com/x.png`,
      `https://b${'a'.repeat(49)}.ipfs.6529usercontent.com/x.png`,
      `https://b${'a'.repeat(62)}.ipfs.6529usercontent.com/x.png`,
      `https://bciq${'a'.repeat(56)}.ipfs.6529usercontent.com/x.png`,
      `http://${cidV1}.ipfs.6529usercontent.com/x.png`,
      `https://${cidV1}.ipfs.6529usercontent.com:8443/x.png`,
      `https://user:pass@${cidV1}.ipfs.6529usercontent.com/x.png`,
      `https://${cidV1}.ipfs.6529usercontent.com.evil.example/x.png`,
      `https://${cidV1}.ipns.6529usercontent.com/x.png`
    ])('does not recognize %s', (input) => {
      expect(parseDecentralizedMediaRef(input)).toBeNull();
    });

    it('recognizes no other host under the content domain', () => {
      fc.assert(
        fc.property(fc.domain(), (prefix) => {
          const host = `${prefix}.6529usercontent.com`;
          fc.pre(host !== 'media.6529usercontent.com');
          fc.pre(!/^b[a-z2-7]{50,61}\.ipfs\.6529usercontent\.com$/.test(host));
          expect(
            parseDecentralizedMediaRef(`https://${host}/ipfs/${cid}/a.png`)
          ).toBeNull();
          expect(
            parseDecentralizedMediaRef(`https://${host}/arweave/${txid}`)
          ).toBeNull();
        })
      );
    });

    it('identifies 6529 media gateway URLs', () => {
      for (const url of [
        `${OLD}/ipfs/${cid}`,
        `http://media.6529.io/ipfs/${cid}`,
        `${NEW}/ipfs/${cid}`,
        `${NEW}/arweave/${txid}`,
        `https://${cidV1}.ipfs.6529usercontent.com/index.html`
      ]) {
        expect(isFirstPartyMediaGatewayUrl(url)).toBe(true);
      }
      for (const url of [
        `https://ipfs.6529.io/ipfs/${cid}`,
        `https://ipfs.io/ipfs/${cid}`,
        `http://media.6529usercontent.com/ipfs/${cid}`,
        `https://media.6529usercontent.com:444/ipfs/${cid}`,
        `https://evil.6529usercontent.com/ipfs/${cid}`,
        `https://a.b.ipfs.6529usercontent.com/x`,
        `https://b${'a'.repeat(50)}.ipfs.6529usercontent.com/x`,
        `https://bciq${'a'.repeat(56)}.ipfs.6529usercontent.com/x`,
        `https://media.6529usercontent.com.evil.example/ipfs/${cid}`,
        `ipfs://${cid}`,
        'not a url'
      ]) {
        expect(isFirstPartyMediaGatewayUrl(url)).toBe(false);
      }
    });
  });
});
