import { ForbiddenException } from '@/exceptions';
import { ProfileCmsWalletGalleryApiService } from '@/api/profile-cms/wallet-gallery.api.service';
import { WalletGalleryCollectionKey } from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.types';

const ADDRESS_ONE = '0x1111111111111111111111111111111111111111';
const ADDRESS_TWO = '0x2222222222222222222222222222222222222222';
const MEMES_CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const GRADIENT_CONTRACT = '0x0c58ef43ff3032005e472cb5709f8908acb00205';

describe('ProfileCmsWalletGalleryApiService', () => {
  it('builds deterministic snapshots from normalized wallets and indexed holdings', async () => {
    const normalizedInputs = {
      inputs: [
        {
          input: ADDRESS_ONE,
          address: ADDRESS_ONE,
          ens: 'alpha.eth',
          display: 'alpha.eth',
          status: 'resolved',
          reason: null
        },
        {
          input: 'missing.eth',
          address: null,
          ens: 'missing.eth',
          display: 'missing.eth',
          status: 'unresolved',
          reason: 'ens_not_found'
        },
        {
          input: ADDRESS_TWO,
          address: ADDRESS_TWO,
          ens: null,
          display: ADDRESS_TWO,
          status: 'resolved',
          reason: null
        }
      ],
      addresses: [ADDRESS_ONE, ADDRESS_TWO]
    };
    const normalizer = {
      normalizeWalletInputs: jest.fn().mockResolvedValue(normalizedInputs)
    };
    const snapshotDb = {
      findHoldingsByWallets: jest.fn().mockResolvedValue([
        {
          owner_wallet: ADDRESS_TWO,
          owner_display: null,
          contract: GRADIENT_CONTRACT,
          token_id: 7,
          balance: 1,
          block_reference: 90,
          name: 'Gradient 7',
          collection: '6529 Gradient',
          collection_key: WalletGalleryCollectionKey.GRADIENTS,
          token_type: 'ERC721',
          description: null,
          artist: 'Artist B',
          artist_seize_handle: null,
          thumbnail: null,
          image: 'https://example.test/gradient.png',
          scaled: 'https://example.test/gradient-preview.webp',
          animation: null,
          compressed_animation: null,
          icon: null,
          metadata: '{"gradient":true}'
        },
        {
          owner_wallet: ADDRESS_ONE,
          owner_display: 'alpha.eth',
          contract: MEMES_CONTRACT,
          token_id: 1,
          balance: '2',
          block_reference: 100,
          name: 'Meme 1',
          collection: 'The Memes',
          collection_key: WalletGalleryCollectionKey.MEMES,
          token_type: 'ERC1155',
          description: 'A meme',
          artist: 'Artist A',
          artist_seize_handle: 'artist-a',
          thumbnail: 'https://example.test/meme-thumb.jpg',
          image: 'https://example.test/meme.png',
          scaled: 'https://example.test/meme-preview.webp',
          animation: 'https://example.test/meme.mp4',
          compressed_animation: 'https://example.test/meme-preview.webm',
          icon: null,
          metadata: { season: 1 }
        }
      ])
    };
    const service = new ProfileCmsWalletGalleryApiService(
      snapshotDb as any,
      normalizer as any,
      () => true,
      () => 123456
    );

    await expect(
      service.createSnapshot(
        {
          wallets: [ADDRESS_ONE, 'missing.eth', ADDRESS_TWO],
          exclude_assets: [{ contract: GRADIENT_CONTRACT, token_id: 7 }],
          max_assets: 1
        },
        {}
      )
    ).resolves.toEqual({
      generated_at: 123456,
      source: 'indexed_ownership',
      block_reference: 100,
      wallets: normalizedInputs.inputs,
      assets: [
        {
          contract: MEMES_CONTRACT,
          token_id: 1,
          balance: 2,
          owner_wallet: ADDRESS_ONE,
          owner_display: 'alpha.eth',
          collection: 'The Memes',
          collection_key: WalletGalleryCollectionKey.MEMES,
          name: 'Meme 1',
          description: 'A meme',
          artist: 'Artist A',
          artist_seize_handle: 'artist-a',
          token_type: 'ERC1155',
          media: {
            image: 'https://example.test/meme.png',
            image_preview: 'https://example.test/meme-preview.webp',
            thumbnail: 'https://example.test/meme-thumb.jpg',
            animation: 'https://example.test/meme.mp4',
            animation_preview: 'https://example.test/meme-preview.webm',
            mime_type: 'video/mp4'
          },
          metadata: { season: 1 },
          flags: {
            spam: false,
            excluded: false,
            exclusion_reason: null
          }
        }
      ],
      excluded_assets: [
        {
          contract: GRADIENT_CONTRACT,
          token_id: 7,
          owner_wallet: ADDRESS_TWO,
          reason: 'asset_excluded'
        }
      ],
      totals: {
        requested_wallets: 3,
        resolved_wallets: 2,
        unresolved_wallets: 1,
        indexed_assets: 2,
        visible_assets: 1,
        excluded_assets: 1,
        spam_assets: 0,
        truncated: false
      }
    });
    expect(snapshotDb.findHoldingsByWallets).toHaveBeenCalledWith(
      [ADDRESS_ONE, ADDRESS_TWO],
      {}
    );
  });

  it('marks visible output as truncated when max_assets cuts indexed holdings', async () => {
    const service = new ProfileCmsWalletGalleryApiService(
      {
        findHoldingsByWallets: jest
          .fn()
          .mockResolvedValue([row({ token_id: 1 }), row({ token_id: 2 })])
      } as any,
      {
        normalizeWalletInputs: jest.fn().mockResolvedValue({
          inputs: [
            {
              input: ADDRESS_ONE,
              address: ADDRESS_ONE,
              ens: null,
              display: ADDRESS_ONE,
              status: 'resolved',
              reason: null
            }
          ],
          addresses: [ADDRESS_ONE]
        })
      } as any,
      () => true,
      () => 1
    );

    const snapshot = await service.createSnapshot(
      { wallets: [ADDRESS_ONE], max_assets: 1 },
      {}
    );

    expect(snapshot.assets.map((asset) => asset.token_id)).toEqual([1]);
    expect(snapshot.totals).toMatchObject({
      indexed_assets: 2,
      visible_assets: 1,
      truncated: true
    });
  });

  it('rejects requests while the feature flag is disabled', async () => {
    const service = new ProfileCmsWalletGalleryApiService(
      { findHoldingsByWallets: jest.fn() } as any,
      { normalizeWalletInputs: jest.fn() } as any,
      () => false,
      () => 1
    );

    await expect(
      service.createSnapshot({ wallets: [ADDRESS_ONE] }, {})
    ).rejects.toThrow(ForbiddenException);
  });
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    owner_wallet: ADDRESS_ONE,
    owner_display: null,
    contract: MEMES_CONTRACT,
    token_id: 1,
    balance: 1,
    block_reference: 1,
    name: 'Meme',
    collection: 'The Memes',
    collection_key: WalletGalleryCollectionKey.MEMES,
    token_type: 'ERC1155',
    description: null,
    artist: null,
    artist_seize_handle: null,
    thumbnail: null,
    image: null,
    scaled: null,
    animation: null,
    compressed_animation: null,
    icon: null,
    metadata: null,
    ...overrides
  };
}
