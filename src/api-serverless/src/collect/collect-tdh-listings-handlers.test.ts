import * as Operations from '@/api/generated/routes/operations';
import { handleGetCollectTdhListings } from './collect-tdh-listings.handlers';
import { getCollectTdhListings } from './collect-tdh-listings.service';

jest.mock('@/api/marketplace/marketplace.http', () => ({
  executeMarketRequest: (_request: unknown, work: () => Promise<unknown>) =>
    work()
}));
jest.mock('./collect-tdh-listings.service', () => ({
  getCollectTdhListings: jest.fn().mockResolvedValue({ entries: [] })
}));

function request(query: unknown): Operations.GetCollectTdhListingsRequest {
  return { query } as Operations.GetCollectTdhListingsRequest;
}

beforeEach(() => jest.clearAllMocks());

it('allows anonymous browsing with Memes and a bounded page as defaults', async () => {
  await expect(handleGetCollectTdhListings(request({}))).resolves.toEqual({
    entries: []
  });
  expect(getCollectTdhListings).toHaveBeenCalledWith('memes', 24, undefined);
});

it('passes the validated collection, cursor and page size', async () => {
  await handleGetCollectTdhListings(
    request({ family: 'pebbles', limit: '12', cursor: 'cursor' })
  );
  expect(getCollectTdhListings).toHaveBeenCalledWith('pebbles', 12, 'cursor');
});

it.each([
  { family: 'all' },
  { limit: '49' },
  { limit: '0' },
  { limit: '1.5' },
  { cursor: 'x'.repeat(2049) },
  { horizon_days: 30 },
  { profile_id: 'profile' },
  { budget_wei: '100' }
])(
  'rejects unsupported query inputs before source reads: %j',
  async (query) => {
    await expect(handleGetCollectTdhListings(request(query))).rejects.toThrow();
    expect(getCollectTdhListings).not.toHaveBeenCalled();
  }
);
