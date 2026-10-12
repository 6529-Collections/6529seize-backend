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
  fetchDelegations: jest.fn(),
  fetchDelegationsByUseCase: jest.fn(),
  fetchMintingDelegations: jest.fn()
}));

jest.mock('@/api/api-helpers', () => ({
  ...jest.requireActual('@/api/api-helpers'),
  returnPaginatedResult: jest.fn()
}));

import {
  fetchDelegations,
  fetchDelegationsByUseCase,
  fetchMintingDelegations
} from '@/db-api';
import './delegations.routes';

type Handler = (req: any, res: any) => Promise<unknown>;

function handlerFor(path: string): Handler {
  const call = mockRouterGet.mock.calls.find(([registered]) => {
    return registered === path;
  });
  if (!call) {
    throw new Error(`no handler registered for ${path}`);
  }
  return call[call.length - 1];
}

const page = { count: 0, page: 1, next: null, data: [] };

describe('delegations routes pagination', () => {
  beforeEach(() => {
    jest.mocked(fetchDelegations).mockReset().mockResolvedValue(page);
    jest.mocked(fetchDelegationsByUseCase).mockReset().mockResolvedValue(page);
    jest.mocked(fetchMintingDelegations).mockReset().mockResolvedValue(page);
  });

  describe.each([
    {
      route: '/:wallet',
      mock: () => jest.mocked(fetchDelegations),
      expectedArgs: (size: number, pageNo: number) => ['0xabc', size, pageNo]
    },
    {
      route: '/minting/:wallet',
      mock: () => jest.mocked(fetchMintingDelegations),
      expectedArgs: (size: number, pageNo: number) => ['0xabc', size, pageNo]
    },
    {
      route: '/',
      mock: () => jest.mocked(fetchDelegationsByUseCase),
      expectedArgs: (size: number, pageNo: number) => [
        undefined,
        undefined,
        false,
        size,
        pageNo,
        undefined
      ]
    }
  ])('$route', ({ route, mock, expectedArgs }) => {
    async function call(query: Record<string, string>) {
      await handlerFor(route)({ params: { wallet: '0xabc' }, query }, {});
      return mock().mock.calls[0];
    }

    it('uses the default page size and first page when nothing is requested', async () => {
      expect(await call({})).toEqual(expectedArgs(50, 1));
    });

    it.each(['0', '-1', '-100'])(
      'floors page size %p at 1 so a LIMIT is always applied',
      async (pageSize) => {
        expect(await call({ page_size: pageSize })).toEqual(expectedArgs(1, 1));
      }
    );

    it.each(['0', '-1', '-100'])(
      'floors page %p at the first page',
      async (pageNo) => {
        expect(await call({ page: pageNo })).toEqual(expectedArgs(50, 1));
      }
    );

    it('falls back to defaults for non-numeric values', async () => {
      expect(await call({ page_size: 'abc', page: 'xyz' })).toEqual(
        expectedArgs(50, 1)
      );
    });

    it('caps oversized page sizes at the default maximum', async () => {
      expect(await call({ page_size: '500' })).toEqual(expectedArgs(50, 1));
    });

    it('keeps valid page size and page values', async () => {
      expect(await call({ page_size: '10', page: '3' })).toEqual(
        expectedArgs(10, 3)
      );
    });
  });
});
