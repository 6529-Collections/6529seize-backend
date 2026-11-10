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
import { BadRequestException } from '@/exceptions';
import { fetchRoyalties } from './royalties.db';
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

describe('royalties collection report', () => {
  function collectionHandler(): Handler {
    const call = mockRouterGet.mock.calls.find(
      ([registered]) => registered === '/collection/:collection_type'
    );
    if (!call) {
      throw new Error('no handler registered for /collection/:collection_type');
    }
    return call[call.length - 1];
  }

  function response() {
    return {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis()
    };
  }

  beforeEach(() => {
    jest.mocked(fetchRoyalties).mockReset().mockResolvedValue([]);
  });

  it('awaits the query and responds with its rows', async () => {
    const rows = [{ token_id: 1 }] as any;
    jest.mocked(fetchRoyalties).mockResolvedValue(rows);
    const res = response();

    await collectionHandler()(
      {
        params: { collection_type: 'memes' },
        query: { from_date: '2026-01-01', to_date: '2026-01-31', artist: 'A' }
      },
      res
    );

    expect(fetchRoyalties).toHaveBeenCalledWith(
      'memes',
      false,
      'A',
      '2026-01-01',
      '2026-01-31',
      undefined,
      undefined
    );
    expect(res.json).toHaveBeenCalledWith(rows);
  });

  it('propagates a query failure instead of leaving the request open', async () => {
    const failure = new Error('db down');
    jest.mocked(fetchRoyalties).mockRejectedValue(failure);

    await expect(
      collectionHandler()(
        { params: { collection_type: 'memes' }, query: {} },
        response()
      )
    ).rejects.toBe(failure);
  });

  it.each(['yesterday', '2026-13-45', '2026-01-01; DROP'])(
    'rejects the malformed date %p',
    async (value) => {
      await expect(
        collectionHandler()(
          { params: { collection_type: 'memes' }, query: { to_date: value } },
          response()
        )
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchRoyalties).not.toHaveBeenCalled();
    }
  );
});
