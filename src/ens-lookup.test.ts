import { getRpcProvider } from '@/rpc-provider';
import { lookupPrimaryEnsName } from '@/ens-lookup';
const mockReverse = jest.fn();
jest.mock('@/rpc-provider', () => ({ getRpcProvider: jest.fn() }));
jest.mock('ethers', () => ({
  Contract: jest.fn(() => ({ reverse: mockReverse }))
}));
import { Contract } from 'ethers';

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
    }
  );
  it('retains null for an unresolved address', async () => {
    lookupAddress.mockResolvedValue(null);
    mockReverse.mockRejectedValue(new Error('unavailable'));
    expect(await lookupPrimaryEnsName('0xaddress')).toBeNull();
  });
  it('fails explicitly when configuration is missing instead of silently using another endpoint', async () => {
    jest.mocked(getRpcProvider).mockImplementation(() => {
      throw new Error('ETHEREUM_RPC_URL is required');
    });
    await expect(lookupPrimaryEnsName('0xaddress')).rejects.toThrow(
      'ETHEREUM_RPC_URL'
    );
  });
});
