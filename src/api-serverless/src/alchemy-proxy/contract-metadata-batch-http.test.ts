import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { Alchemy } from '@/alchemy-sdk';
import { getAlchemyInstance } from '@/alchemy';
import { ApiCompliantException } from '@/exceptions';
import router from '@/api/alchemy-proxy/alchemy-proxy.routes';

jest.mock('@/alchemy-sdk', () => ({ Alchemy: jest.fn() }));
jest.mock('@/alchemy', () => ({ getAlchemyInstance: jest.fn() }));
jest.mock('@/api/request-cache', () => ({
  cacheRequest: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

const ADDRESS = '0x0000000000000000000000000000000000000001';
const mockLookup = jest.fn();
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/alchemy-proxy', router);
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status =
      error instanceof ApiCompliantException ? error.getStatusCode() : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Unexpected error'
    });
  };
  app.use(errors);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  url = `http://127.0.0.1:${address.port}/alchemy-proxy/contracts`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReset();
  jest
    .mocked(getAlchemyInstance)
    .mockReturnValue({ config: { apiKey: 'test-key' } } as Alchemy);
  jest
    .mocked(Alchemy)
    .mockImplementation(
      () => ({ nft: { getContractMetadata: mockLookup } }) as unknown as Alchemy
    );
});

function post(body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

it('serves the batch envelope at the existing root-level fallback URL', async () => {
  mockLookup.mockResolvedValue({ name: 'Collection', tokenType: 'ERC721' });
  const response = await post({ contracts: [{ address: ADDRESS }] });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    contracts: [
      {
        address: ADDRESS,
        chain: 'ethereum',
        metadata: {
          name: 'Collection',
          tokenType: 'ERC721',
          _checksum: ADDRESS
        }
      }
    ]
  });
});

it.each([
  {},
  { contracts: [{ address: 'invalid' }] },
  { contracts: [{ address: ADDRESS, chain: 'polygon' }] }
])('forwards async validation failures to HTTP 400: %j', async (body) => {
  const response = await post(body);
  expect(response.status).toBe(400);
  expect(getAlchemyInstance).not.toHaveBeenCalled();
});

it('forwards an oversized batch to HTTP 413', async () => {
  const response = await post({
    contracts: Array.from({ length: 51 }, () => ({ address: ADDRESS }))
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: 'Maximum 50 contracts per request'
  });
  expect(getAlchemyInstance).not.toHaveBeenCalled();
});

it('forwards provider initialization failure to HTTP 500 without leaking its message', async () => {
  jest.mocked(getAlchemyInstance).mockImplementation(() => {
    throw new Error('private-provider-detail');
  });
  const response = await post({ contracts: [{ address: ADDRESS }] });
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: 'Contract metadata provider is unavailable'
  });
});
