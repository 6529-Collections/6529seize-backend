import type { MintingClaimUpdateRequest } from '@/api/generated/models/MintingClaimUpdateRequest';
import type { MintingClaimRow } from '@/api/minting-claims/api.minting-claims.db';
import { buildUpdatesForClaimPatch } from '@/api/minting-claims/api.minting-claims.service';
import {
  computeAnimationDetailsVideo,
  computeImageDetails
} from '@/minting-claims/media-inspector';

jest.mock('@/minting-claims/media-inspector', () => ({
  computeImageDetails: jest.fn(),
  computeAnimationDetailsVideo: jest.fn(),
  computeAnimationDetailsGlb: jest.fn(),
  animationDetailsHtml: jest.fn(() => ({ format: 'HTML' }))
}));

function baseClaim(overrides: Partial<MintingClaimRow> = {}): MintingClaimRow {
  return {
    drop_id: 'drop-1',
    contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
    claim_id: 1,
    image_location: 'old-image-tx',
    animation_location: 'old-animation-tx',
    metadata_location: 'old-metadata-tx',
    media_uploading: false,
    edition_size: 300,
    description: 'desc',
    name: 'name',
    image_url: 'https://cdn.example.com/image.png',
    external_url: 'https://6529.io',
    attributes: '[]',
    image_details: JSON.stringify({
      bytes: 100,
      format: 'PNG',
      sha256: 'a'.repeat(64),
      width: 10,
      height: 10
    }),
    animation_url: 'https://cdn.example.com/animation.mp4',
    animation_details: JSON.stringify({
      bytes: 100,
      format: 'MP4',
      duration: 1,
      sha256: 'b'.repeat(64),
      width: 10,
      height: 10,
      codecs: []
    }),
    ...overrides
  };
}

describe('buildUpdatesForClaimPatch', () => {
  const computeImageDetailsMock = computeImageDetails as jest.MockedFunction<
    typeof computeImageDetails
  >;
  const computeAnimationDetailsVideoMock =
    computeAnimationDetailsVideo as jest.MockedFunction<
      typeof computeAnimationDetailsVideo
    >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears image_location when image_url changes', async () => {
    computeImageDetailsMock.mockResolvedValue({
      bytes: 123,
      format: 'GIF',
      sha256: 'c'.repeat(64),
      width: 20,
      height: 20
    });
    const body: MintingClaimUpdateRequest = {
      image_url: 'https://cdn.example.com/new-image.gif'
    };

    const updates = await buildUpdatesForClaimPatch(body, baseClaim(), false);

    expect(updates.image_location).toBeNull();
    expect(updates.metadata_location).toBeNull();
    expect(updates.image_url).toBe('https://cdn.example.com/new-image.gif');
  });

  it('keeps image_location when image_url is unchanged', async () => {
    computeImageDetailsMock.mockResolvedValue({
      bytes: 100,
      format: 'PNG',
      sha256: 'a'.repeat(64),
      width: 10,
      height: 10
    });
    const existing = baseClaim();
    const body: MintingClaimUpdateRequest = { image_url: existing.image_url };

    const updates = await buildUpdatesForClaimPatch(body, existing, false);

    expect(updates.image_location).toBeUndefined();
    expect(updates.metadata_location).toBeUndefined();
  });

  it('clears animation_location when animation_url changes', async () => {
    computeAnimationDetailsVideoMock.mockResolvedValue({
      bytes: 321,
      format: 'MP4',
      duration: 2,
      sha256: 'd'.repeat(64),
      width: 30,
      height: 30,
      codecs: ['avc1']
    });
    const body: MintingClaimUpdateRequest = {
      animation_url: 'https://cdn.example.com/new-animation.mp4'
    };

    const updates = await buildUpdatesForClaimPatch(body, baseClaim(), false);

    expect(updates.animation_location).toBeNull();
    expect(updates.metadata_location).toBeNull();
    expect(updates.animation_url).toBe(
      'https://cdn.example.com/new-animation.mp4'
    );
  });

  it('treats whitespace-only URL differences as unchanged', async () => {
    const existing = baseClaim();
    const body: MintingClaimUpdateRequest = {
      image_url: `  ${existing.image_url}  `
    };

    const updates = await buildUpdatesForClaimPatch(body, existing, false);

    expect(updates.image_url).toBeUndefined();
    expect(updates.image_location).toBeUndefined();
    expect(updates.metadata_location).toBeUndefined();
  });

  it('treats empty-string image_url as unchanged when existing is null', async () => {
    const existing = baseClaim({ image_url: null, image_location: null });
    const body: MintingClaimUpdateRequest = {
      image_url: '   '
    };

    const updates = await buildUpdatesForClaimPatch(body, existing, false);

    expect(updates.image_url).toBeUndefined();
    expect(updates.image_location).toBeUndefined();
    expect(updates.metadata_location).toBeUndefined();
  });
});
