import type { Request, Response } from 'express';
import { ethers } from 'ethers';
import * as fc from 'fast-check';
import { Alchemy } from '@/alchemy-sdk';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { handleContractMetadataBatch } from '@/api/alchemy-proxy/contract-metadata-batch.handler';

jest.mock('@/alchemy-sdk', () => ({ Alchemy: jest.fn() }));

const ADDRESS = '0xa94161fbe69e08ff5a36dfafa61bdf29dd2fb928';
const CHECKSUM = ethers.getAddress(ADDRESS);
const mockLookup = jest.fn();

function response() {
  return { setHeader: jest.fn(), json: jest.fn().mockReturnThis() };
}

async function request(body: unknown) {
  const res = response();
  await handleContractMetadataBatch(
    { body } as Request,
    res as unknown as Response
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReset();
  jest.mocked(Alchemy).mockImplementation(
    () =>
      ({
        nft: { getContractMetadata: mockLookup }
      }) as unknown as Alchemy
  );
});

it('returns the existing desktop batch envelope with checksummed metadata', async () => {
  const metadata = {
    name: 'Voxelglyph',
    tokenType: 'ERC721',
    totalSupply: '273',
    openSeaMetadata: { floorPrice: 0.469 }
  };
  mockLookup.mockResolvedValue(metadata);
  const res = await request({
    contracts: [{ address: ADDRESS, chain: 'ethereum' }]
  });
  expect(res.json).toHaveBeenCalledWith({
    contracts: [
      {
        address: CHECKSUM,
        chain: 'ethereum',
        metadata: { ...metadata, _checksum: CHECKSUM }
      }
    ]
  });
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});

it('deduplicates differently cased aliases and defaults the chain', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.hexaString({ minLength: 40, maxLength: 40 }),
      async (hex) => {
        mockLookup.mockClear();
        mockLookup.mockResolvedValue({});
        const address = `0x${hex.toLowerCase()}`;
        await request({
          contracts: [
            { address },
            { address: `0x${hex.toUpperCase()}`, chain: 'ethereum' }
          ]
        });
        expect(mockLookup).toHaveBeenCalledTimes(1);
        expect(mockLookup).toHaveBeenCalledWith(ethers.getAddress(address));
      }
    ),
    { numRuns: 30 }
  );
});

it('returns an empty batch without constructing an upstream client', async () => {
  const res = await request({ contracts: [] });
  expect(res.json).toHaveBeenCalledWith({ contracts: [] });
  expect(Alchemy).not.toHaveBeenCalled();
});

it.each([
  null,
  {},
  [],
  { contracts: null },
  { contracts: ['not-a-contract'] },
  { contracts: [{ address: '0x123' }] },
  { contracts: [{ address: ADDRESS, chain: 'polygon' }] },
  { contracts: [{ address: ADDRESS, unexpected: true }] },
  { contracts: [], unexpected: true }
])('rejects malformed input before upstream lookup: %j', async (body) => {
  await expect(request(body)).rejects.toBeInstanceOf(BadRequestException);
  expect(Alchemy).not.toHaveBeenCalled();
});

it('rejects an oversized batch with 413 before upstream lookup', async () => {
  const res = response();
  const invoke = handleContractMetadataBatch(
    {
      body: {
        contracts: Array.from({ length: 51 }, () => ({ address: ADDRESS }))
      }
    } as Request,
    res as unknown as Response
  );
  await expect(invoke).rejects.toBeInstanceOf(CustomApiCompliantException);
  await expect(invoke).rejects.toMatchObject({
    message: 'Maximum 50 contracts per request'
  });
  expect(Alchemy).not.toHaveBeenCalled();
});

it('preserves successes and distinguishes missing metadata from upstream failure', async () => {
  const addresses = [1, 2, 3, 4].map(
    (id) => `0x${id.toString(16).padStart(40, '0')}`
  );
  mockLookup
    .mockResolvedValueOnce({ name: 'Available' })
    .mockRejectedValueOnce({ status: 404 })
    .mockRejectedValueOnce({
      status: 429,
      message: 'credential-in-provider-url'
    })
    .mockRejectedValueOnce(new Error('credential-in-provider-url'));
  const res = await request({
    contracts: addresses.map((address) => ({ address }))
  });
  expect(res.json).toHaveBeenCalledWith({
    contracts: [
      {
        address: addresses[0],
        chain: 'ethereum',
        metadata: { name: 'Available', _checksum: addresses[0] }
      },
      { address: addresses[1], chain: 'ethereum', metadata: null },
      {
        address: addresses[2],
        chain: 'ethereum',
        metadata: null,
        error: 'Failed to fetch contract metadata',
        status: 429
      },
      {
        address: addresses[3],
        chain: 'ethereum',
        metadata: null,
        error: 'Failed to fetch contract metadata',
        status: 502
      }
    ]
  });
});

it('bounds concurrency for a maximum-sized batch and configures finite upstream timeouts', async () => {
  let active = 0;
  let peak = 0;
  mockLookup.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return {};
  });
  const contracts = Array.from({ length: 50 }, (_, id) => ({
    address: `0x${id.toString(16).padStart(40, '0')}`
  }));
  await request({ contracts });
  expect(mockLookup).toHaveBeenCalledTimes(50);
  expect(peak).toBeLessThanOrEqual(10);
  expect(Alchemy).toHaveBeenCalledWith(
    expect.objectContaining({ timeoutMs: 5000, maxRetries: 0 })
  );
});
