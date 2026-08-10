import { DropsDb } from '@/drops/drops.db';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import { RequestContext } from '@/request.context';
import { MemeCardDropMappingsDb } from './meme-card-drop-mappings.db';
import { MintingClaimsDb } from './minting-claims.db';
import { MintingClaimsService } from './minting-claims.service';

jest.mock('@/http/safe-fetch', () => ({
  fetchPublicUrlToBuffer: jest.fn()
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
