import { getNextgenNetwork } from './nextgen_constants';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';

describe('NextGen RPC network selection', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });
  it('defaults to mainnet only when no chain is configured', () => {
    delete process.env.NEXTGEN_CHAIN_ID;
    expect(getNextgenNetwork()).toBe(Network.ETH_MAINNET);
  });
  it.each([
    ['1', Network.ETH_MAINNET],
    ['11155111', Network.ETH_SEPOLIA],
    ['5', Network.ETH_GOERLI]
  ])('selects the exact supported chain %s', (chainId, network) => {
    process.env.NEXTGEN_CHAIN_ID = chainId;
    expect(getNextgenNetwork()).toBe(network);
  });
  it.each(['560048', '137', '11155111invalid'])(
    'does not silently map %s to mainnet',
    (chainId) => {
      process.env.NEXTGEN_CHAIN_ID = chainId;
      expect(getNextgenNetwork).toThrow('Unsupported NEXTGEN_CHAIN_ID');
    }
  );
});
