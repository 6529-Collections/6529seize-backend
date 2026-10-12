import 'reflect-metadata';
import { RateMatter } from '@/entities/IRating';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { RatingsService } from '@/rates/ratings.service';

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getIdentityAndConsolidationsByIdentityKey: jest.fn()
  }
}));

const emptyPage = { page: 1, next: false, count: 0, data: [] };

function createService() {
  const ratingsDb = {
    getRatingsByRatersForMatter: jest.fn().mockResolvedValue(emptyPage)
  };
  const repService = {
    getRepForProfiles: jest.fn().mockResolvedValue({})
  };
  const service = new RatingsService(
    ratingsDb as any,
    repService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, ratingsDb };
}

async function paginationFor(queryParams: Record<string, string | undefined>) {
  const { service, ratingsDb } = createService();
  await service.getRatingsByRatersForMatter({
    queryParams,
    identity: 'someone',
    matter: RateMatter.REP
  });
  const [params] = ratingsDb.getRatingsByRatersForMatter.mock.calls[0];
  return { page: params.page, page_size: params.page_size };
}

describe('ratings by-rater pagination parameters', () => {
  beforeEach(() => {
    jest
      .mocked(identityFetcher.getIdentityAndConsolidationsByIdentityKey)
      .mockResolvedValue({
        id: 'profile-id',
        primary_wallet: '0x1111111111111111111111111111111111111111'
      } as any);
  });

  it('uses the default page size and first page when nothing is requested', async () => {
    expect(await paginationFor({})).toEqual({ page: 1, page_size: 200 });
  });

  it.each(['0', '-1', '-200'])('floors page_size=%p at 1', async (pageSize) => {
    expect(await paginationFor({ page_size: pageSize })).toEqual({
      page: 1,
      page_size: 1
    });
  });

  it.each(['0', '-1', '-9'])(
    'floors page=%p at the first page',
    async (page) => {
      expect(await paginationFor({ page })).toEqual({
        page: 1,
        page_size: 200
      });
    }
  );

  it.each(['abc', '1.5', '1e3', ' '])(
    'falls back to defaults instead of NaN for %p',
    async (value) => {
      expect(await paginationFor({ page: value, page_size: value })).toEqual({
        page: 1,
        page_size: 200
      });
    }
  );

  it('keeps valid values', async () => {
    expect(await paginationFor({ page: '3', page_size: '25' })).toEqual({
      page: 3,
      page_size: 25
    });
  });
});
