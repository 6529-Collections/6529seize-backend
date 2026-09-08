import type { Request, Response, RequestHandler } from 'express';

jest.mock('express', () => ({
  Router: jest.fn(() => ({ get: jest.fn(), post: jest.fn() }))
}));
jest.mock('@/alchemy', () => ({ getAlchemyInstance: jest.fn() }));
jest.mock('@/api/request-cache', () => ({
  cacheRequest: jest.fn(() => jest.fn())
}));

import { Router } from 'express';
import { getAlchemyInstance } from '@/alchemy';
import '@/api/alchemy-proxy/alchemy-proxy.routes';

const mockRouter = jest.mocked(Router).mock.results[0].value;
const mockGetContractMetadata = jest.fn();
const ADDRESS = '0x0000000000000000000000000000000000000001';

function handlerFor(path: string): RequestHandler {
  const route = mockRouter.get.mock.calls.find(
    (args: unknown[]) => args[0] === path
  );
  if (!route) throw new Error('Missing route: ' + path);
  return route.at(-1);
}

async function request(path: string, query: Record<string, unknown> = {}) {
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
  await handlerFor(path)(
    { query } as unknown as Request,
    res as unknown as Response,
    jest.fn()
  );
  return res;
}

beforeEach(() => {
  jest.mocked(getAlchemyInstance).mockReset();
  mockGetContractMetadata.mockReset();
  jest.mocked(getAlchemyInstance).mockReturnValue({
    nft: { getContractMetadata: mockGetContractMetadata }
  } as unknown as ReturnType<typeof getAlchemyInstance>);
});

describe('retired collection search', () => {
  it.each([{}, { query: 'memes' }, { query: ADDRESS }, { query: ['a', 'b'] }])(
    'returns a non-cacheable 410 without Alchemy for %j',
    async (query) => {
      const res = await request('/collections', query);
      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(res.json).toHaveBeenCalledWith({
        error:
          'Collection name search is no longer available. Use a contract address.'
      });
      expect(getAlchemyInstance).not.toHaveBeenCalled();
      const route = mockRouter.get.mock.calls.find(
        (args: unknown[]) => args[0] === '/collections'
      );
      expect(route).toHaveLength(2); // No old search-cache middleware.
    }
  );
});

describe('retained contract-address fallback', () => {
  it('returns metadata directly with the checksum, not a search envelope', async () => {
    const metadata = {
      address: ADDRESS,
      name: 'Collection',
      tokenType: 'ERC721',
      openSeaMetadata: { floorPrice: 1 }
    };
    mockGetContractMetadata.mockResolvedValue(metadata);
    const res = await request('/contract', { address: ADDRESS });
    expect(mockGetContractMetadata).toHaveBeenCalledWith(ADDRESS);
    expect(res.json).toHaveBeenCalledWith({ ...metadata, _checksum: ADDRESS });
  });

  it.each([undefined, '', 'memes', '0x123'])(
    'rejects invalid address %s before upstream lookup',
    async (address) => {
      const res = await request('/contract', { address });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(getAlchemyInstance).not.toHaveBeenCalled();
    }
  );

  it('returns null for missing contract metadata', async () => {
    mockGetContractMetadata.mockRejectedValue({ status: 404 });
    const res = await request('/contract', { address: ADDRESS });
    expect(res.json).toHaveBeenCalledWith(null);
  });

  it('preserves the existing error status for upstream failure', async () => {
    mockGetContractMetadata.mockRejectedValue(
      new Error('upstream unavailable')
    );
    const res = await request('/contract', { address: ADDRESS });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'upstream unavailable' });
  });
});
