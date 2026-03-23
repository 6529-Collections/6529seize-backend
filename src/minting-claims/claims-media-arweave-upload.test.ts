import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import type { MintingClaimRow } from '@/api/minting-claims/api.minting-claims.db';
import { arweaveFileUploader } from '@/arweave';
import { MEMES_CONTRACT } from '@/constants';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import {
  uploadMintingClaimToArweave,
  validateMintingClaimReadyForArweaveUpload
} from '@/minting-claims/claims-media-arweave-upload';
import {
  fetchMaxSeasonId,
  fetchMemeIdByMemeName
} from '@/api/minting-claims/api.minting-claims.db';

jest.mock('@/api/minting-claims/api.minting-claims.db', () => ({
  fetchMaxSeasonId: jest.fn(),
  fetchMemeIdByMemeName: jest.fn()
}));

jest.mock('@/arweave', () => ({
  arweaveFileUploader: {
    uploadFile: jest.fn()
  }
}));

jest.mock('@/http/safe-fetch', () => ({
  fetchPublicUrlToBuffer: jest.fn()
}));

function buildMemesRawAttributes() {
  return [
    {
      trait_type: 'Artist',
      value: 'awhurst',
      display_type: 'text'
    },
    {
      trait_type: 'SEIZE Artist Profile',
      value: 'awhurst'
    },
    {
      trait_type: 'Meme Name',
      value: 'Survive'
    },
    {
      display_type: 'boost_percentage',
      trait_type: 'Points - Power',
      value: 100,
      max_value: 100
    },
    {
      display_type: 'boost_percentage',
      trait_type: 'Points - Wisdom',
      value: 100,
      max_value: 100
    },
    {
      display_type: 'boost_percentage',
      trait_type: 'Points - Loki',
      value: 100,
      max_value: 100
    },
    {
      display_type: 'boost_percentage',
      trait_type: 'Points - Speed',
      value: 5,
      max_value: 100
    },
    {
      trait_type: 'Punk 6529',
      value: 'No'
    },
    {
      trait_type: 'Gradient',
      value: 'Yes'
    },
    {
      trait_type: 'Movement',
      value: 'Yes'
    },
    {
      trait_type: 'Dynamic',
      value: 'No'
    },
    {
      trait_type: 'Interactive',
      value: 'No'
    },
    {
      trait_type: 'Collab',
      value: 'No'
    },
    {
      trait_type: 'OM',
      value: 'No'
    },
    {
      trait_type: '3D',
      value: 'No'
    },
    {
      trait_type: 'Pepe',
      value: 'No'
    },
    {
      trait_type: 'GM',
      value: 'No'
    },
    {
      trait_type: 'Summer',
      value: 'No'
    },
    {
      trait_type: 'Tulip',
      value: 'No'
    },
    {
      trait_type: 'Bonus',
      value: 'm0dest'
    },
    {
      trait_type: 'Boost',
      value: 'bribe'
    },
    {
      trait_type: 'Palette',
      value: 'Color'
    },
    {
      trait_type: 'Style',
      value: 'noise'
    },
    {
      trait_type: 'Jewel',
      value: 'visionary'
    },
    {
      trait_type: 'Superpower',
      value: 'networked'
    },
    {
      trait_type: 'Dharma',
      value: 'strong'
    },
    {
      trait_type: 'Gear',
      value: 'gold chain'
    },
    {
      trait_type: 'Clothing',
      value: 'optional'
    },
    {
      trait_type: 'Element',
      value: 'fire'
    },
    {
      trait_type: 'Mystery',
      value: 'death and taxes'
    },
    {
      trait_type: 'Secrets',
      value: 'paying taxes'
    },
    {
      trait_type: 'Weapon',
      value: 'audit'
    },
    {
      trait_type: 'Home',
      value: '6529 Foundation'
    },
    {
      trait_type: 'Parent',
      value: 'none'
    },
    {
      trait_type: 'Sibling',
      value: 'none'
    },
    {
      trait_type: 'Food',
      value: 'ETH'
    },
    {
      trait_type: 'Drink',
      value: 'none'
    },
    {
      display_type: 'number',
      trait_type: 'Type - Season',
      value: 14
    }
  ];
}

function baseClaim(overrides: Partial<MintingClaimRow> = {}): MintingClaimRow {
  return {
    drop_id: 'drop-1',
    contract: MEMES_CONTRACT,
    claim_id: 471,
    image_location: null,
    animation_location: null,
    metadata_location: null,
    media_uploading: false,
    edition_size: 300,
    description: 'desc',
    name: 'name',
    image_url: 'https://cdn.example.com/image.png',
    external_url: 'https://6529.io/the-memes/471',
    attributes: JSON.stringify(buildMemesRawAttributes()),
    image_details: JSON.stringify({
      bytes: 123,
      format: 'PNG',
      sha256: 'a'.repeat(64),
      width: 800,
      height: 800
    }),
    animation_url: null,
    animation_details: null,
    ...overrides
  };
}

describe('validateMintingClaimReadyForArweaveUpload', () => {
  const fetchMaxSeasonIdMock = fetchMaxSeasonId as jest.MockedFunction<
    typeof fetchMaxSeasonId
  >;
  const fetchMemeIdByMemeNameMock =
    fetchMemeIdByMemeName as jest.MockedFunction<typeof fetchMemeIdByMemeName>;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMaxSeasonIdMock.mockResolvedValue(14);
    fetchMemeIdByMemeNameMock.mockResolvedValue(9);
  });

  it('accepts a MEMES claim when the final trait set is exact', async () => {
    await expect(
      validateMintingClaimReadyForArweaveUpload(baseClaim(), MEMES_CONTRACT)
    ).resolves.toEqual({
      imageUrl: 'https://cdn.example.com/image.png',
      typeMemeId: 9,
      seasonValue: 14
    });
  });

  it('accepts MEMES claims with extra traits outside the skeleton', async () => {
    const attributes = [
      ...buildMemesRawAttributes(),
      {
        trait_type: 'Allowlist_batches',
        value: '[]'
      }
    ];

    await expect(
      validateMintingClaimReadyForArweaveUpload(
        baseClaim({ attributes: JSON.stringify(attributes) }),
        MEMES_CONTRACT
      )
    ).resolves.toEqual({
      imageUrl: 'https://cdn.example.com/image.png',
      typeMemeId: 9,
      seasonValue: 14
    });
  });

  it('rejects missing MEMES traits before Arweave upload', async () => {
    const attributes = buildMemesRawAttributes().filter(
      (attribute) => attribute.trait_type !== 'Boost'
    );

    await expect(
      validateMintingClaimReadyForArweaveUpload(
        baseClaim({ attributes: JSON.stringify(attributes) }),
        MEMES_CONTRACT
      )
    ).rejects.toThrow(
      'Invalid fields for Arweave upload: MEMES Attributes (missing traits: Boost).'
    );
  });

  it('rejects MEMES claims with missing required metadata keys', async () => {
    await expect(
      validateMintingClaimReadyForArweaveUpload(
        baseClaim({ external_url: null, image_details: null }),
        MEMES_CONTRACT
      )
    ).rejects.toThrow(
      'Invalid fields for Arweave upload: MEMES Metadata (missing keys: external_url, image_details).'
    );
  });

  it('rejects MEMES claims with incomplete animation metadata', async () => {
    await expect(
      validateMintingClaimReadyForArweaveUpload(
        baseClaim({
          animation_url: 'https://cdn.example.com/animation.mp4',
          animation_details: JSON.stringify({
            format: 'MP4',
            bytes: 456,
            duration: 4,
            width: 1000,
            height: 1000,
            codecs: ['HEVC (H.265)']
          })
        }),
        MEMES_CONTRACT
      )
    ).rejects.toThrow(
      'Invalid fields for Arweave upload: MEMES animation_details (missing keys: sha256).'
    );
  });
});

describe('uploadMintingClaimToArweave', () => {
  const fetchMaxSeasonIdMock = fetchMaxSeasonId as jest.MockedFunction<
    typeof fetchMaxSeasonId
  >;
  const fetchMemeIdByMemeNameMock =
    fetchMemeIdByMemeName as jest.MockedFunction<typeof fetchMemeIdByMemeName>;
  const uploadFileMock = arweaveFileUploader.uploadFile as jest.MockedFunction<
    typeof arweaveFileUploader.uploadFile
  >;
  const fetchPublicUrlToBufferMock =
    fetchPublicUrlToBuffer as jest.MockedFunction<
      typeof fetchPublicUrlToBuffer
    >;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMaxSeasonIdMock.mockResolvedValue(14);
    fetchMemeIdByMemeNameMock.mockResolvedValue(9);
    fetchPublicUrlToBufferMock.mockResolvedValue({
      buffer: Buffer.from('image-bytes'),
      contentType: 'image/png',
      finalUrl: 'https://cdn.example.com/image.png'
    });
    uploadFileMock
      .mockResolvedValueOnce({ url: 'https://arweave.net/image-tx' })
      .mockResolvedValueOnce({ url: 'https://arweave.net/metadata-tx' });
  });

  it('uploads only the known MEMES metadata keys', async () => {
    await uploadMintingClaimToArweave(
      MEMES_CONTRACT,
      baseClaim({
        attributes: JSON.stringify([
          ...buildMemesRawAttributes(),
          {
            trait_type: 'Allowlist_batches',
            value: 'drop-me'
          }
        ]),
        image_details: JSON.stringify({
          bytes: 123,
          format: 'PNG',
          sha256: 'a'.repeat(64),
          width: 800,
          height: 800,
          ignored: 'drop-me'
        })
      })
    );

    expect(uploadFileMock).toHaveBeenCalledTimes(2);
    const metadataUploadBuffer = uploadFileMock.mock.calls[1]?.[0] as Buffer;
    const uploadedMetadata = JSON.parse(metadataUploadBuffer.toString('utf8'));

    expect(Object.keys(uploadedMetadata).sort()).toEqual([
      'attributes',
      'created_by',
      'description',
      'external_url',
      'image',
      'image_details',
      'image_url',
      'name'
    ]);
    expect(uploadedMetadata.image_details).toEqual({
      bytes: 123,
      format: 'PNG',
      sha256: 'a'.repeat(64),
      width: 800,
      height: 800
    });
    expect(uploadedMetadata.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trait_type: 'Allowlist_batches'
        })
      ])
    );
  });

  it('uploads HTML MEMES metadata in the expected legacy shape', async () => {
    uploadFileMock.mockReset();
    uploadFileMock
      .mockResolvedValueOnce({ url: 'https://arweave.net/image-tx' })
      .mockResolvedValueOnce({ url: 'https://arweave.net/metadata-tx' });

    await uploadMintingClaimToArweave(
      MEMES_CONTRACT,
      baseClaim({
        animation_url: 'https://cdn.example.com/interactive.html',
        animation_details: JSON.stringify({
          format: 'HTML',
          ignored: 'drop-me'
        })
      })
    );

    const metadataUploadBuffer = uploadFileMock.mock.calls[1]?.[0] as Buffer;
    const uploadedMetadata = JSON.parse(metadataUploadBuffer.toString('utf8'));

    expect(uploadedMetadata.animation).toBeUndefined();
    expect(uploadedMetadata.animation_url).toBe(
      'https://cdn.example.com/interactive.html'
    );
    expect(uploadedMetadata.animation_details).toBe('{ "format": "HTML" }');
  });

  it('uploads GLB MEMES metadata in the expected object shape', async () => {
    uploadFileMock.mockReset();
    fetchPublicUrlToBufferMock.mockResolvedValue({
      buffer: Buffer.from('glb-bytes'),
      contentType: 'model/gltf-binary',
      finalUrl: 'https://cdn.example.com/model.glb'
    });
    uploadFileMock
      .mockResolvedValueOnce({ url: 'https://arweave.net/image-tx' })
      .mockResolvedValueOnce({ url: 'https://arweave.net/glb-tx' })
      .mockResolvedValueOnce({ url: 'https://arweave.net/metadata-tx' });

    await uploadMintingClaimToArweave(
      MEMES_CONTRACT,
      baseClaim({
        animation_url: 'https://cdn.example.com/model.glb',
        animation_details: JSON.stringify({
          bytes: 8133420,
          format: 'GLB',
          sha256: 'b'.repeat(64),
          ignored: 'drop-me'
        })
      })
    );

    const metadataUploadBuffer = uploadFileMock.mock.calls[2]?.[0] as Buffer;
    const uploadedMetadata = JSON.parse(metadataUploadBuffer.toString('utf8'));

    expect(uploadedMetadata.animation).toBe('https://arweave.net/glb-tx');
    expect(uploadedMetadata.animation_url).toBe('https://arweave.net/glb-tx');
    expect(uploadedMetadata.animation_details).toEqual({
      bytes: 8133420,
      format: 'GLB',
      sha256: 'b'.repeat(64)
    });
  });
});
