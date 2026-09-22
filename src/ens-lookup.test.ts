import { getRpcProvider } from '@/rpc-provider';
import { lookupPrimaryEnsName } from '@/ens-lookup';
import { Logger } from '@/logging';
const mockReverse = jest.fn();
jest.mock('@/logging', () => {
  const logger = { info: jest.fn(), debug: jest.fn() };
  return { Logger: { get: () => logger } };
});
jest.mock('@/rpc-provider', () => ({ getRpcProvider: jest.fn() }));
jest.mock('ethers', () => ({
  Contract: jest.fn(() => ({ reverse: mockReverse }))
}));
import { Contract } from 'ethers';
const mockInfo = jest.mocked(Logger.get('ENS_LOOKUP').info);

describe('ENS uses one configured RPC endpoint', () => {
  const lookupAddress = jest.fn();
  const provider = { lookupAddress };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getRpcProvider).mockReturnValue(provider as never);
  });
  it('returns the primary reverse result without an additional lookup', async () => {
    lookupAddress.mockResolvedValue('primary.eth');
    expect(await lookupPrimaryEnsName('0xaddress')).toBe('primary.eth');
    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });
  it.each(['miss', 'error'])(
    'uses the same provider for Universal Resolver after a %s',
    async (mode) => {
      if (mode === 'miss') lookupAddress.mockResolvedValue(null);
      else lookupAddress.mockRejectedValue(new Error('unavailable'));
      mockReverse.mockResolvedValue(['fallback.eth']);
      expect(await lookupPrimaryEnsName('0xaddress')).toBe('fallback.eth');
      expect(Contract).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        provider
      );
      expect(mockInfo).toHaveBeenCalledTimes(1);
      expect(mockInfo).toHaveBeenCalledWith(
        '[ENS_UNIVERSAL_RESOLVER] [OUTCOME=hit]'
      );
    }
  );
  it('retains null for an unresolved address', async () => {
    lookupAddress.mockResolvedValue(null);
    mockReverse.mockRejectedValue(
      new Error('https://rpc.example.test/secret-key')
    );
    expect(await lookupPrimaryEnsName('0xaddress')).toBeNull();
    expect(mockInfo.mock.calls).toEqual([
      ['[ENS_UNIVERSAL_RESOLVER] [OUTCOME=error]']
    ]);
  });
  it('records a clean fallback miss separately from a transport error', async () => {
    lookupAddress.mockResolvedValue(null);
    mockReverse.mockResolvedValue(['']);
    expect(await lookupPrimaryEnsName('0xaddress')).toBeNull();
    expect(mockInfo.mock.calls).toEqual([
      ['[ENS_UNIVERSAL_RESOLVER] [OUTCOME=miss]']
    ]);
  });
  it('fails explicitly when configuration is missing instead of silently using another endpoint', async () => {
    jest.mocked(getRpcProvider).mockImplementation(() => {
      throw new Error('ETHEREUM_RPC_URL is required');
    });
    await expect(lookupPrimaryEnsName('0xaddress')).rejects.toThrow(
      'ETHEREUM_RPC_URL'
    );
    expect(mockInfo).not.toHaveBeenCalled();
  });
});
