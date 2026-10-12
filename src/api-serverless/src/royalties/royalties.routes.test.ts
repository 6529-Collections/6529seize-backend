const mockRouterGet = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({
    get: mockRouterGet
  })
}));

jest.mock('@/api/request-cache', () => ({
  cacheRequest: () => jest.fn()
}));

jest.mock('@/db-api', () => ({
  fetchRoyaltiesUploads: jest.fn()
}));

jest.mock('./royalties.db', () => ({
  fetchRoyalties: jest.fn()
}));

jest.mock('@/api/api-helpers', () => ({
  ...jest.requireActual('@/api/api-helpers'),
  returnPaginatedResult: jest.fn()
}));

import { fetchRoyaltiesUploads } from '@/db-api';
import './royalties.routes';

type Handler = (req: any, res: any) => Promise<unknown>;

function uploadsHandler(): Handler {
  const call = mockRouterGet.mock.calls.find(
    ([registered]) => registered === '/uploads'
  );
  if (!call) {
    throw new Error('no handler registered for /uploads');
  }
  return call[call.length - 1];
}

describe('royalties uploads pagination', () => {
  beforeEach(() => {
    jest
      .mocked(fetchRoyaltiesUploads)
      .mockReset()
      .mockResolvedValue({ count: 0, page: 1, next: null, data: [] });
  });

  async function pagination(query: Record<string, string>) {
    await uploadsHandler()({ query }, {});
    const [pageSize, page] = jest.mocked(fetchRoyaltiesUploads).mock.calls[0];
    return { pageSize, page };
  }

  it('uses the default page size and first page', async () => {
    expect(await pagination({})).toEqual({ pageSize: 50, page: 1 });
  });

  it.each(['0', '-1', '-50'])(
    'floors page_size and page of %p to 1',
    async (value) => {
      expect(await pagination({ page_size: value, page: value })).toEqual({
        pageSize: 1,
        page: 1
      });
    }
  );

  it('keeps valid values', async () => {
    expect(await pagination({ page_size: '10', page: '2' })).toEqual({
      pageSize: 10,
      page: 2
    });
  });
});
