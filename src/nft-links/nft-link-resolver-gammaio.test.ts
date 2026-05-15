const fetchJsonWithTimeoutMock = jest.fn();
const fetchTextWithTimeoutMock = jest.fn();

jest.mock('@/nft-links/lib/http', () => ({
  fetchJsonWithTimeout: fetchJsonWithTimeoutMock,
  fetchTextWithTimeout: fetchTextWithTimeoutMock
}));

import { NftLinkResolver } from '@/nft-links/nft-link-resolver';

type ResolveContext = Parameters<NftLinkResolver['resolve']>[1];

describe('NftLinkResolver Gamma.io support', () => {
  const resolveContext: ResolveContext = {};

  beforeEach(() => {
    fetchJsonWithTimeoutMock.mockReset();
    fetchTextWithTimeoutMock.mockReset();
  });

  it('resolves Gamma.io collection token links from page metadata', async () => {
    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <meta property="og:title" content="Hash One #1058" />
          <meta property="og:description" content="A Stacks NFT on Gamma.io" />
          <meta property="og:image" content="https://cdn.gamma.io/hash-one.png" />
        </head>
      </html>
    `);

    const result = await new NftLinkResolver().resolve(
      'https://gamma.io/collections/thisisnumberone-v2/1058?utm_source=test',
      resolveContext
    );

    expect(result.identifier.platform).toBe('GAMMAIO');
    expect(result.identifier.canonicalId).toBe(
      'GAMMAIO:collection:thisisnumberone-v2:1058'
    );
    expect(result.asset).toMatchObject({
      title: 'Hash One #1058',
      description: 'A Stacks NFT on Gamma.io',
      collection: { name: 'Thisisnumberone V2' },
      tokenId: '1058',
      media: {
        kind: 'image',
        imageUrl: 'https://cdn.gamma.io/hash-one.png'
      }
    });
    expect(result.market.cta).toEqual({
      label: 'View on Gamma.io',
      url: 'https://gamma.io/collections/thisisnumberone-v2/1058'
    });
  });

  it('resolves Gamma.io Stacks NFT links from Gamma API metadata and price', async () => {
    const nftId =
      'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-genesis-nft_1114';

    fetchTextWithTimeoutMock.mockResolvedValue('<html><head></head></html>');
    fetchJsonWithTimeoutMock.mockResolvedValue({
      item: {
        id: nftId,
        name: 'Stacking DAO Genesis NFT #1114',
        description: 'Congrats you are an early adopter of liquid stacking!',
        asset_content: {
          content_url: 'https://arweave.net/stacking-dao-genesis'
        },
        collection: {
          name: 'Stacking DAO Genesis NFT'
        },
        market_summary: {
          listing: {
            price_amount: {
              amount: 17999999,
              unit: 'micro_stacks'
            }
          }
        }
      }
    });

    const result = await new NftLinkResolver().resolve(
      `https://gamma.io/stacks/nfts/${nftId}`,
      resolveContext
    );

    expect(result.identifier.platform).toBe('GAMMAIO');
    expect(result.identifier.canonicalId).toBe(`GAMMAIO:stacks:${nftId}`);
    expect(result.asset).toMatchObject({
      title: 'Stacking DAO Genesis NFT #1114',
      description: 'Congrats you are an early adopter of liquid stacking!',
      collection: { name: 'Stacking DAO Genesis NFT' },
      tokenId: '1114',
      media: {
        kind: 'image',
        imageUrl: 'https://arweave.net/stacking-dao-genesis'
      }
    });
    expect(result.market.price).toEqual({
      amount: '18.0',
      currency: 'STX'
    });
    expect(result.market.saleType).toBe('FIXED');
    expect(fetchJsonWithTimeoutMock).toHaveBeenCalledWith(
      `https://gamma.io/api/get-stacks-nft?id=${encodeURIComponent(nftId)}`,
      expect.any(Object)
    );
  });

  it('resolves Gamma.io ordinal links from JSON-LD metadata', async () => {
    const inscriptionId =
      '521f8eccffa4c41a3a7728dd012ea5a4a02feed81f41159231251ecf1e5c79dai0';

    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@type": "VisualArtwork",
              "name": "Ordinal Artifact",
              "description": "A Bitcoin ordinal listed on Gamma.io",
              "image": "https://cdn.gamma.io/ordinal.png"
            }
          </script>
        </head>
      </html>
    `);
    fetchJsonWithTimeoutMock.mockResolvedValue({
      item: {
        market_summary: {
          listing: {
            price_amount: {
              amount: 5000000,
              unit: 'sats'
            }
          }
        }
      }
    });

    const result = await new NftLinkResolver().resolve(
      `https://gamma.io/ordinals/${inscriptionId}`,
      resolveContext
    );

    expect(result.identifier.platform).toBe('GAMMAIO');
    expect(result.identifier.canonicalId).toBe(
      `GAMMAIO:ordinal:${inscriptionId}`
    );
    expect(result.asset).toMatchObject({
      title: 'Ordinal Artifact',
      description: 'A Bitcoin ordinal listed on Gamma.io',
      media: {
        kind: 'image',
        imageUrl: 'https://cdn.gamma.io/ordinal.png'
      }
    });
    expect(result.market.price).toEqual({
      amount: '0.05',
      currency: 'BTC'
    });
    expect(result.market.saleType).toBe('FIXED');
    expect(fetchJsonWithTimeoutMock).toHaveBeenCalledWith(
      `https://gamma.io/api/get-inscription?id=${inscriptionId}`,
      expect.any(Object)
    );
  });

  it('resolves Gamma.io links from JSON-LD @graph metadata', async () => {
    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "name": "Gamma.io"
                },
                {
                  "@type": "VisualArtwork",
                  "name": "Graph Token",
                  "image": "https://cdn.gamma.io/graph-token.png"
                }
              ]
            }
          </script>
        </head>
      </html>
    `);

    const result = await new NftLinkResolver().resolve(
      'https://gamma.io/collections/thisisnumberone-v2/1058',
      resolveContext
    );

    expect(result.asset).toMatchObject({
      title: 'Graph Token',
      media: {
        kind: 'image',
        imageUrl: 'https://cdn.gamma.io/graph-token.png'
      }
    });
  });

  it('keeps Gamma.io ordinal price empty when listing data is unavailable', async () => {
    const inscriptionId =
      '521f8eccffa4c41a3a7728dd012ea5a4a02feed81f41159231251ecf1e5c79dai0';

    fetchTextWithTimeoutMock.mockResolvedValue(`
      <html>
        <head>
          <meta property="og:title" content="Unlisted Ordinal" />
          <meta property="og:image" content="https://cdn.gamma.io/unlisted.png" />
        </head>
      </html>
    `);
    fetchJsonWithTimeoutMock.mockResolvedValue({
      item: {
        market_summary: {}
      }
    });

    const result = await new NftLinkResolver().resolve(
      `https://gamma.io/ordinals/inscriptions/${inscriptionId}`,
      resolveContext
    );

    expect(result.market.price).toBeUndefined();
    expect(result.market.saleType).toBe('UNKNOWN');
  });

  it('fails when Gamma.io page metadata cannot be extracted', async () => {
    fetchTextWithTimeoutMock.mockResolvedValue('<html><head></head></html>');

    await expect(
      new NftLinkResolver().resolve(
        'https://gamma.io/collections/thisisnumberone-v2/1058',
        resolveContext
      )
    ).rejects.toThrow(
      'Unable to extract Gamma.io metadata from https://gamma.io/collections/thisisnumberone-v2/1058'
    );
  });
});
