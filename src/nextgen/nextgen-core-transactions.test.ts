import { ethers } from 'ethers';
import type { EntityManager } from 'typeorm';
import { processLog } from '@/nextgen/nextgen_core_transactions';

jest.mock('@/nextgen/nextgen.db', () => ({}));
jest.mock('@/ens-lookup', () => ({}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn(), info: jest.fn() }) }
}));

const address = '0x00000000219ab540356cBB839Cbe05303d7705Fa';
const args = ethers.Result.fromItems([BigInt(7), address]);
const entityManager = {} as EntityManager;
const originalFetch = global.fetch;

describe('NextGen randomizer logs', () => {
  const originalChainId = process.env.NEXTGEN_CHAIN_ID;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalChainId === undefined) delete process.env.NEXTGEN_CHAIN_ID;
    else process.env.NEXTGEN_CHAIN_ID = originalChainId;
  });

  it.each(['1', '11155111', '5'])(
    'uses the configured chain %s and preserves the named log format',
    async (chainId) => {
      process.env.NEXTGEN_CHAIN_ID = chainId;
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ compilation: { name: 'Randomizer' } }))
      );
      await expect(
        processLog(entityManager, 'addRandomizer', args)
      ).resolves.toEqual([
        {
          id: 7,
          title: 'Randomizer Added',
          description: `Randomizer Added - Randomizer (${address})`
        }
      ]);
      expect(fetchMock.mock.calls[0][0]).toContain(
        `/contract/${chainId}/${address}?`
      );
    }
  );

  it.each(['unverified', 'network error'])(
    'still creates the address log on %s',
    async (failure) => {
      if (failure === 'unverified')
        fetchMock.mockResolvedValue(new Response('', { status: 404 }));
      else fetchMock.mockRejectedValue(new Error('offline'));
      await expect(
        processLog(entityManager, 'addRandomizer', args)
      ).resolves.toEqual([
        {
          id: 7,
          title: 'Randomizer Added',
          description: `Randomizer Added - ${address}`
        }
      ]);
    }
  );
});
