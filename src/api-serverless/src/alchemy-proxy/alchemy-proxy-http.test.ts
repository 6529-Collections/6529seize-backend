import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { getAlchemyInstance } from '@/alchemy';
import { ApiCompliantException } from '@/exceptions';
import router from '@/api/alchemy-proxy/alchemy-proxy.routes';

jest.mock('@/alchemy', () => ({ getAlchemyInstance: jest.fn() }));
jest.mock('@/api/request-cache', () => ({
  cacheRequest: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

const ADDRESS = '0x0000000000000000000000000000000000000001';
const mockBatch = jest.fn();
const mockOwnerNfts = jest.fn();
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
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
  baseUrl = `http://127.0.0.1:${address.port}/alchemy-proxy`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  mockBatch.mockReset().mockResolvedValue({ nfts: [{ id: 1 }] });
  mockOwnerNfts.mockReset().mockResolvedValue({ ownedNfts: [] });
  jest
    .mocked(getAlchemyInstance)
    .mockReset()
    .mockReturnValue({
      nft: { getNftMetadataBatch: mockBatch, getNftsForOwner: mockOwnerNfts }
    } as unknown as ReturnType<typeof getAlchemyInstance>);
});

function postTokenMetadata(body: unknown) {
  return fetch(`${baseUrl}/token-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function manyTokens(length: number) {
  return Array.from({ length }, (_, i) => ({
    contract: ADDRESS,
    tokenId: String(i)
  }));
}

describe('POST /token-metadata', () => {
  it('fetches the requested tokens in one batch', async () => {
    const response = await postTokenMetadata({
      tokens: [{ contract: ADDRESS, tokenId: '7' }],
      chain: 'ethereum'
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tokens: [{ id: 1 }] });
    expect(mockBatch).toHaveBeenCalledWith([
      { contractAddress: ADDRESS, tokenId: '7' }
    ]);
  });

  it('accepts an address with token ids', async () => {
    const response = await postTokenMetadata({
      address: ADDRESS,
      tokenIds: ['1', 2]
    });
    expect(response.status).toBe(200);
    expect(mockBatch).toHaveBeenCalledWith([
      { contractAddress: ADDRESS, tokenId: '1' },
      { contractAddress: ADDRESS, tokenId: '2' }
    ]);
  });

  it('accepts exactly 100 tokens', async () => {
    const response = await postTokenMetadata({ tokens: manyTokens(100) });
    expect(response.status).toBe(200);
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('answers 413 for more than 100 tokens without calling the provider', async () => {
    const response = await postTokenMetadata({ tokens: manyTokens(101) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Maximum 100 tokens per request'
    });
    expect(getAlchemyInstance).not.toHaveBeenCalled();
  });

  it('answers 413 for more than 100 token ids', async () => {
    const response = await postTokenMetadata({
      address: ADDRESS,
      tokenIds: Array.from({ length: 101 }, (_, i) => String(i))
    });
    expect(response.status).toBe(413);
    expect(getAlchemyInstance).not.toHaveBeenCalled();
  });

  it.each([
    { tokens: [{ contract: 'nope', tokenId: '1' }] },
    { tokens: [{ contract: ADDRESS, tokenId: 'abc' }] },
    { address: 'nope', tokenIds: ['1'] },
    { address: ADDRESS, tokenIds: [{ nested: true }] }
  ])('answers 400 for malformed body %j', async (body) => {
    const response = await postTokenMetadata(body);
    expect(response.status).toBe(400);
    expect(getAlchemyInstance).not.toHaveBeenCalled();
  });

  it('keeps the existing 400 when nothing is requested', async () => {
    const response = await postTokenMetadata({});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Either tokens OR (address and tokenIds) are required'
    });
  });
});

describe('GET /owner-nfts', () => {
  it('passes validated parameters to the provider', async () => {
    const response = await fetch(
      `${baseUrl}/owner-nfts?chainId=1&contract=${ADDRESS}&owner=${ADDRESS}`
    );
    expect(response.status).toBe(200);
    expect(mockOwnerNfts).toHaveBeenCalledWith(ADDRESS, {
      contractAddresses: [ADDRESS],
      pageKey: undefined
    });
  });

  it.each([
    `chainId=1&contract=nope&owner=${ADDRESS}`,
    `chainId=1&contract=${ADDRESS}&owner=${'a'.repeat(300)}`,
    `chainId=1&contract=${ADDRESS}&owner=${ADDRESS}&pageKey=${'k'.repeat(2000)}`
  ])('answers 400 for %s', async (query) => {
    const response = await fetch(`${baseUrl}/owner-nfts?${query}`);
    expect(response.status).toBe(400);
    expect(getAlchemyInstance).not.toHaveBeenCalled();
  });
});

describe('error forwarding', () => {
  it('turns a provider initialization failure into an error response', async () => {
    jest.mocked(getAlchemyInstance).mockImplementation(() => {
      throw new Error('init failed');
    });
    const response = await fetch(
      `${baseUrl}/owner-nfts?chainId=1&contract=${ADDRESS}&owner=${ADDRESS}`
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
