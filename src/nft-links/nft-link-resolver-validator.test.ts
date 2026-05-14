import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';

describe('validateLinkUrl', () => {
  describe('Gamma.io links', () => {
    const inscriptionId =
      '521f8eccffa4c41a3a7728dd012ea5a4a02feed81f41159231251ecf1e5c79dai0';

    it.each([
      `https://gamma.io/ordinals/${inscriptionId}`,
      `https://gamma.io/inscriptions/${inscriptionId}`,
      `https://gamma.io/ordinals/collections/sample-collection/inscriptions/${inscriptionId}`
    ])('recognizes ordinal inscription URL %s', (url) => {
      const result = validateLinkUrl(url);

      expect(result.platform).toBe('GAMMAIO');
      expect(result.identifiers).toEqual({
        kind: 'URL_ONLY',
        customId: `ordinal:${inscriptionId}`
      });
      expect(result.canonicalId).toBe(`GAMMAIO:ordinal:${inscriptionId}`);
      expect(result.viewUrl).toBe(url);
    });

    it.each([
      [
        'https://gamma.io/collections/stacks-collection/123?utm_source=test',
        'stacks-collection',
        '123',
        'https://gamma.io/collections/stacks-collection/123'
      ],
      [
        'gamma.io/collections/stacks-collection/tokens/000123/',
        'stacks-collection',
        '123',
        'https://gamma.io/collections/stacks-collection/tokens/000123'
      ]
    ])(
      'recognizes collection token URL %s',
      (url, collectionSlug, tokenId, expectedViewUrl) => {
        const result = validateLinkUrl(url);

        expect(result.platform).toBe('GAMMAIO');
        expect(result.identifiers).toEqual({
          kind: 'URL_ONLY',
          customId: `collection:${collectionSlug}:${tokenId}`
        });
        expect(result.canonicalId).toBe(
          `GAMMAIO:collection:${collectionSlug}:${tokenId}`
        );
        expect(result.viewUrl).toBe(expectedViewUrl);
      }
    );

    it('recognizes Stacks NFT URLs', () => {
      const nftId =
        'SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-genesis-nft_1114';
      const result = validateLinkUrl(`https://gamma.io/stacks/nfts/${nftId}`);

      expect(result.platform).toBe('GAMMAIO');
      expect(result.identifiers).toEqual({
        kind: 'URL_ONLY',
        customId: `stacks:${nftId}`
      });
      expect(result.canonicalId).toBe(`GAMMAIO:stacks:${nftId}`);
      expect(result.viewUrl).toBe(`https://gamma.io/stacks/nfts/${nftId}`);
    });

    it('rejects Gamma.io collection pages without a token or inscription id', () => {
      expect(() =>
        validateLinkUrl('https://gamma.io/collections/stacks-collection')
      ).toThrow(NftLinkResolverValidationError);
    });

    it('rejects Gamma.io links with malformed percent-encoding in the path', () => {
      expect(() =>
        validateLinkUrl('https://gamma.io/collections/bad%zz/123')
      ).toThrow(
        'Gamma.io link has malformed percent-encoding in path segment: bad%zz.'
      );
    });

    it('rejects Gamma.io collection token identifiers that cannot fit persistence', () => {
      expect(() =>
        validateLinkUrl(`https://gamma.io/collections/${'a'.repeat(65)}/123`)
      ).toThrow(NftLinkResolverValidationError);

      expect(() =>
        validateLinkUrl(
          `https://gamma.io/collections/${'a'.repeat(64)}/${'1'.repeat(30)}`
        )
      ).toThrow(NftLinkResolverValidationError);
    });
  });
});
