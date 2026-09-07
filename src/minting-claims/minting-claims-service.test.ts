import { DropsDb } from '@/drops/drops.db';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import {
  computeAnimationDetailsGlb,
  computeAnimationDetailsVideo,
  computeImageDetails
} from '@/minting-claims/media-inspector';
import { RequestContext } from '@/request.context';
import type { MintingClaimRowInput } from './minting-claim-from-drop.builder';
import { MemeCardDropMappingsDb } from './meme-card-drop-mappings.db';
import { MintingClaimsDb } from './minting-claims.db';
import { MintingClaimsService } from './minting-claims.service';
import * as claimBuilder from '@/minting-claims/minting-claim-from-drop.builder';
import type {
  MintingClaimAnimationDetailsVideo,
  MintingClaimImageDetails
} from '@/entities/IMintingClaim';

jest.mock('@/http/safe-fetch', () => ({
  fetchPublicUrlToBuffer: jest.fn()
}));
jest.mock('@/minting-claims/media-inspector', () => ({
  animationDetailsHtml: jest.fn(() => ({ format: 'HTML' })),
  computeAnimationDetailsGlb: jest.fn(),
  computeAnimationDetailsVideo: jest.fn(),
  computeImageDetails: jest.fn()
}));

type MappingInvoker = {
  saveMemeCardMappingIfMainStageWinner(
    dropId: string,
    memeCardId: number,
    ctx: RequestContext
  ): Promise<void>;
};

type SeasonInvoker = {
  resolveSeasonForClaimBuild(
    claimId: number,
    ctx: RequestContext
  ): Promise<number>;
};

type EnrichmentInvoker = {
  enrichRowWithComputedDetails(
    row: MintingClaimRowInput
  ): Promise<MintingClaimRowInput>;
};

function claimRowInput(
  overrides: Partial<MintingClaimRowInput> = {}
): MintingClaimRowInput {
  return {
    drop_id: 'drop-1',
    contract: '0x0000000000000000000000000000000000000001',
    claim_id: 1,
    image_location: null,
    animation_location: null,
    metadata_location: null,
    description: 'description',
    name: 'name',
    image_url: null,
    external_url: null,
    attributes: [],
    image_details: null,
    animation_url: null,
    animation_details: null,
    animation_kind: null,
    ...overrides
  };
}

describe('MintingClaimsService Main Stage mapping', () => {
  it('resolves the Main Stage wave after runtime configuration loads', async () => {
    let mainStageWaveId: string | null = null;
    const mappingsDb = {
      isMainStageWinnerDrop: jest.fn().mockResolvedValue(true),
      setMemeCardIdForDrop: jest.fn().mockResolvedValue(undefined)
    } as unknown as MemeCardDropMappingsDb;
    const service = new MintingClaimsService(
      {} as DropsDb,
      {} as MintingClaimsDb,
      mappingsDb,
      () => mainStageWaveId
    ) as unknown as MappingInvoker;
    const ctx = { connection: {} } as RequestContext;

    await service.saveMemeCardMappingIfMainStageWinner('drop-1', 521, ctx);
    expect(mappingsDb.isMainStageWinnerDrop).not.toHaveBeenCalled();

    mainStageWaveId = 'main-stage-wave';
    await service.saveMemeCardMappingIfMainStageWinner('drop-1', 521, ctx);

    expect(mappingsDb.isMainStageWinnerDrop).toHaveBeenCalledWith(
      'drop-1',
      'main-stage-wave',
      ctx
    );
    expect(mappingsDb.setMemeCardIdForDrop).toHaveBeenCalledWith(
      'drop-1',
      521,
      'main-stage-wave',
      ctx
    );
  });
});

describe('MintingClaimsService claim season resolution', () => {
  const fetchPublicUrlToBufferMock =
    fetchPublicUrlToBuffer as jest.MockedFunction<
      typeof fetchPublicUrlToBuffer
    >;
  const getMaxSeasonIdMock = jest.fn().mockResolvedValue(16);
  const ctx = { connection: {} } as RequestContext;
  const service = new MintingClaimsService(
    {} as DropsDb,
    { getMaxSeasonId: getMaxSeasonIdMock } as unknown as MintingClaimsDb,
    {} as MemeCardDropMappingsDb,
    () => null
  ) as unknown as SeasonInvoker;

  beforeEach(() => {
    jest.clearAllMocks();
    getMaxSeasonIdMock.mockResolvedValue(16);
  });

  async function resolveCalendarSeason(season: unknown): Promise<number> {
    fetchPublicUrlToBufferMock.mockResolvedValue({
      buffer: Buffer.from(JSON.stringify({ season })),
      contentType: 'application/json',
      finalUrl: 'https://6529.io/api/meme-calendar/521'
    });
    return await service.resolveSeasonForClaimBuild(521, ctx);
  }

  it.each([
    ['current', 16],
    ['next', 17]
  ])('accepts the %s season for a new claim', async (_label, season) => {
    await expect(resolveCalendarSeason(season)).resolves.toBe(season);
  });

  it.each([
    ['historical', 15],
    ['too-far future', 18],
    ['nonpositive', 0]
  ])(
    'falls back to the current season for a %s calendar season',
    async (_label, season) => {
      await expect(resolveCalendarSeason(season)).resolves.toBe(16);
    }
  );

  it('fetches the season maximum once when the calendar request fails', async () => {
    fetchPublicUrlToBufferMock.mockRejectedValue(new Error('calendar down'));

    await expect(service.resolveSeasonForClaimBuild(521, ctx)).resolves.toBe(
      16
    );
    expect(getMaxSeasonIdMock).toHaveBeenCalledTimes(1);
  });
});

describe('MintingClaimsService media enrichment', () => {
  const imageDetails: MintingClaimImageDetails = {
    bytes: 100,
    format: 'PNG',
    sha256: 'a'.repeat(64),
    width: 100,
    height: 100
  };
  const videoDetails: MintingClaimAnimationDetailsVideo = {
    ...imageDetails,
    format: 'MP4',
    duration: 1,
    codecs: ['avc1']
  };
  const service = new MintingClaimsService(
    {} as DropsDb,
    {} as MintingClaimsDb,
    {} as MemeCardDropMappingsDb,
    () => null
  ) as unknown as EnrichmentInvoker;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['zero bytes', { bytes: 0 }],
    ['oversize', { bytes: 250_000_001 }],
    ['empty hash', { sha256: '' }],
    ['zero dimension', { width: 0 }],
    ['zero duration', { duration: 0 }],
    ['empty codecs', { codecs: [] }]
  ])('does not insert a claim with computed %s', async (_label, overrides) => {
    jest
      .mocked(computeAnimationDetailsVideo)
      .mockResolvedValue({ ...videoDetails, ...overrides });
    jest.spyOn(claimBuilder, 'buildMintingClaimRowFromDrop').mockReturnValue(
      claimRowInput({
        animation_url: 'https://cdn.example.com/art.mp4',
        animation_kind: 'video'
      })
    );
    const createMintingClaim = jest.fn();
    const db = {
      createMintingClaim,
      getMaxClaimId: jest.fn().mockResolvedValue(520),
      getMaxSeasonId: jest.fn().mockResolvedValue(16)
    };
    const drops = {
      getDropMedia: jest.fn().mockResolvedValue({}),
      findMetadataByDropIds: jest.fn().mockResolvedValue([])
    };
    const creationService = new MintingClaimsService(
      drops as unknown as DropsDb,
      db as unknown as MintingClaimsDb,
      {} as MemeCardDropMappingsDb,
      () => null
    );
    await expect(
      creationService.createClaimForDrop('drop-1', {
        connection: {}
      } as RequestContext)
    ).rejects.toThrow('Invalid computed media details');
    expect(createMintingClaim).not.toHaveBeenCalled();
  });

  it('rejects invalid computed preview metadata', async () => {
    jest
      .mocked(computeImageDetails)
      .mockResolvedValue({ ...imageDetails, sha256: '' });
    await expect(
      service.enrichRowWithComputedDetails(
        claimRowInput({ image_url: 'https://cdn.example.com/art.png' })
      )
    ).rejects.toThrow('sha256');
  });

  it('accepts valid image/video details without requiring finished draft fields', async () => {
    jest.mocked(computeImageDetails).mockResolvedValue(imageDetails);
    jest.mocked(computeAnimationDetailsVideo).mockResolvedValue(videoDetails);
    const row = claimRowInput({
      image_url: 'https://cdn.example.com/art.png',
      animation_url: 'https://cdn.example.com/art.mp4',
      animation_kind: 'video'
    });
    await expect(service.enrichRowWithComputedDetails(row)).resolves.toEqual({
      ...row,
      image_details: imageDetails,
      animation_details: videoDetails
    });
  });

  it('accepts GLB details without video-only properties', async () => {
    const details = {
      bytes: 100,
      format: 'GLB' as const,
      sha256: 'a'.repeat(64)
    };
    jest.mocked(computeAnimationDetailsGlb).mockResolvedValue(details);
    await expect(
      service.enrichRowWithComputedDetails(
        claimRowInput({
          animation_url: 'https://cdn.example.com/art.glb',
          animation_kind: 'glb'
        })
      )
    ).resolves.toMatchObject({ animation_details: details });
  });

  it('preserves HTML details without fabricated binary properties', async () => {
    await expect(
      service.enrichRowWithComputedDetails(
        claimRowInput({
          animation_url: 'https://arweave.net/art',
          animation_kind: 'html'
        })
      )
    ).resolves.toMatchObject({ animation_details: { format: 'HTML' } });
  });

  it('fails claim creation enrichment when preview inspection fails', async () => {
    jest.mocked(computeImageDetails).mockRejectedValue(new Error('too large'));

    await expect(
      service.enrichRowWithComputedDetails(
        claimRowInput({ image_url: 'https://cdn.example.com/preview.png' })
      )
    ).rejects.toThrow('too large');
  });

  it('fails claim creation enrichment when GLB inspection fails', async () => {
    jest
      .mocked(computeAnimationDetailsGlb)
      .mockRejectedValue(new Error('invalid glb'));

    await expect(
      service.enrichRowWithComputedDetails(
        claimRowInput({
          animation_url: 'https://cdn.example.com/scene.glb',
          animation_kind: 'glb'
        })
      )
    ).rejects.toThrow('invalid glb');
  });
});
