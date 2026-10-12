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
  fetchPaginated: jest.fn()
}));

jest.mock('@/api/api-helpers', () => ({
  ...jest.requireActual('@/api/api-helpers'),
  returnPaginatedResult: jest.fn()
}));

import { fetchPaginated } from '@/db-api';
import './sitemap.routes';

type Handler = (req: any, res: any) => Promise<unknown>;

function handlerFor(path: string): Handler {
  const call = mockRouterGet.mock.calls.find(
    ([registered]) => registered === path
  );
  if (!call) {
    throw new Error(`no handler registered for ${path}`);
  }
  return call[call.length - 1];
}

describe('sitemap routes pagination', () => {
  beforeEach(() => {
    jest
      .mocked(fetchPaginated)
      .mockReset()
      .mockResolvedValue({ count: 0, page: 1, next: null, data: [] });
  });

  async function pagination(query: Record<string, string>) {
    await handlerFor('/memes')({ query }, {});
    const calls = jest.mocked(fetchPaginated).mock.calls;
    const [, , , pageSize, page] = calls[calls.length - 1];
    return { pageSize, page };
  }

  it('uses the sitemap page size and first page by default', async () => {
    expect(await pagination({})).toEqual({ pageSize: 200, page: 1 });
  });

  it.each(['0', '-1', '-200'])(
    'never removes the LIMIT for page_size=%p',
    async (pageSize) => {
      expect(await pagination({ page_size: pageSize })).toEqual({
        pageSize: 1,
        page: 1
      });
    }
  );

  it.each(['0', '-1', '-5'])(
    'floors page=%p at the first page',
    async (page) => {
      expect(await pagination({ page })).toEqual({ pageSize: 200, page: 1 });
    }
  );

  it('caps oversized page sizes and keeps valid values', async () => {
    expect(await pagination({ page_size: '5000' })).toEqual({
      pageSize: 200,
      page: 1
    });
    expect(await pagination({ page_size: '25', page: '4' })).toEqual({
      pageSize: 25,
      page: 4
    });
  });
});
