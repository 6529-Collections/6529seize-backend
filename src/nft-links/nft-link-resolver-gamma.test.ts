const fetchTextWithTimeoutMock = jest.fn();

jest.mock('@/nft-links/lib/http', () => ({
  fetchTextWithTimeout: fetchTextWithTimeoutMock
}));

import { NftLinkResolver } from '@/nft-links/nft-link-resolver';

describe('NftLinkResolver Gamma support', () => {
  beforeEach(() => {
    fetchTextWithTimeoutMock.mockReset();
  });

  it('resolves Gamma collection token links from page metadata', async () => {
    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <meta property="og:title" content="Hash One #1058" />
          <meta property="og:description" content="A Stacks NFT on Gamma" />
          <meta property="og:image" content="https://cdn.gamma.io/hash-one.png" />
        </head>
      </html>
    `);

    const result = await new NftLinkResolver().resolve(
      'https://gamma.io/collections/thisisnumberone-v2/1058?utm_source=test',
      {} as any
    );

    expect(result.identifier.platform).toBe('GAMMA');
    expect(result.identifier.canonicalId).toBe(
      'GAMMA:collection:thisisnumberone-v2:1058'
    );
    expect(result.asset).toMatchObject({
      title: 'Hash One #1058',
      description: 'A Stacks NFT on Gamma',
      collection: { name: 'Thisisnumberone V2' },
      tokenId: '1058',
      media: {
        kind: 'image',
        imageUrl: 'https://cdn.gamma.io/hash-one.png'
      }
    });
    expect(result.market.cta).toEqual({
      label: 'View on Gamma',
      url: 'https://gamma.io/collections/thisisnumberone-v2/1058'
    });
  });

  it('resolves Gamma ordinal links from JSON-LD metadata', async () => {
    const inscriptionId =
      '521f8eccffa4c41a3a7728dd012ea5a4a02feed81f41159231251ecf1e5c79dai0';

    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@type": "VisualArtwork",
              "name": "Ordinal Artifact",
              "description": "A Bitcoin ordinal listed on Gamma",
              "image": "https://cdn.gamma.io/ordinal.png"
            }
          </script>
        </head>
      </html>
    `);

    const result = await new NftLinkResolver().resolve(
      `https://gamma.io/ordinals/${inscriptionId}`,
      {} as any
    );

    expect(result.identifier.platform).toBe('GAMMA');
    expect(result.identifier.canonicalId).toBe(
      `GAMMA:ordinal:${inscriptionId}`
    );
    expect(result.asset).toMatchObject({
      title: 'Ordinal Artifact',
      description: 'A Bitcoin ordinal listed on Gamma',
      media: {
        kind: 'image',
        imageUrl: 'https://cdn.gamma.io/ordinal.png'
      }
    });
  });
});
