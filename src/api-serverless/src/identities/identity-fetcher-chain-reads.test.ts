import { chainIdentityReads } from '@/identity-chain-mirror/chain-identity-reads';
import { IdentityFetcher } from './identity.fetcher';

jest.mock('@/identity-chain-mirror/chain-identity-reads', () => ({
  identityReadsFromChain: jest.fn(() => true),
  chainIdentityReads: { byWallet: jest.fn(async () => null) }
}));

describe('IdentityFetcher with identities read from the chain', () => {
  it("answers the bare wallet while the chain's identity of it can't be placed", async () => {
    const getIdentityByWallet = jest.fn();
    const fetcher = new IdentityFetcher(
      { getIdentityByWallet } as never,
      {} as never,
      {} as never,
      {} as never,
      () => ({ resolveName: jest.fn() })
    );
    const wallet = '0x' + '0a'.repeat(20);
    await expect(
      fetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: wallet },
        {}
      )
    ).resolves.toMatchObject({
      id: null,
      handle: null,
      primary_wallet: wallet,
      consolidation_key: wallet,
      query: wallet
    });
    expect(chainIdentityReads.byWallet).toHaveBeenCalledWith(wallet);
    expect(getIdentityByWallet).not.toHaveBeenCalled();
    await expect(
      fetcher.getProfileIdByIdentityKey({ identityKey: wallet }, {})
    ).resolves.toBeNull();
  });
});
