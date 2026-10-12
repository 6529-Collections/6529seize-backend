import { JsonRpcProvider } from 'ethers';
import { Network } from './ethereum-rpc-network';
import {
  get6529TraceProvider,
  getAlchemyTraceProvider
} from './trace-provider';

describe('explicit trace provider policy', () => {
  const originalEnv = process.env;
  const providers = new Set<JsonRpcProvider>();
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ALCHEMY_API_KEY: 'trace-test-key',
      ETHEREUM_RPC_URL: 'https://ordinary.example.test'
    };
  });
  afterEach(() => {
    providers.forEach((provider) => provider.destroy());
    providers.clear();
    process.env = originalEnv;
  });
  it('keeps Alchemy trace selection independent of the ordinary RPC URL', () => {
    const provider = getAlchemyTraceProvider(Network.ETH_MAINNET);
    providers.add(provider);
    expect(provider._getConnection().url).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/trace-test-key'
    );
    expect(getAlchemyTraceProvider(Network.ETH_MAINNET)).toBe(provider);
    process.env.ETHEREUM_RPC_URL = 'https://replacement.example.test';
    expect(getAlchemyTraceProvider(Network.ETH_MAINNET)).toBe(provider);
    delete process.env.ALCHEMY_API_KEY;
    expect(() => getAlchemyTraceProvider(Network.ETH_MAINNET)).toThrow(
      'ALCHEMY_API_KEY'
    );
  });
  it('never routes testnet tracing to the mainnet 6529 endpoint', () => {
    const provider = get6529TraceProvider(Network.ETH_MAINNET);
    providers.add(provider);
    expect(provider._getConnection().url).toBe('https://rpc1.6529.io');
    expect(() => get6529TraceProvider(Network.ETH_SEPOLIA)).toThrow(
      'mainnet only'
    );
    expect(() => get6529TraceProvider(Network.ETH_GOERLI)).toThrow(
      'mainnet only'
    );
  });
});
