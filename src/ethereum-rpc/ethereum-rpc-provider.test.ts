import type { JsonRpcProvider } from 'ethers';

describe('Ethereum RPC provider foundation', () => {
  const originalEnv = process.env;
  const providers = new Set<JsonRpcProvider>();

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.ETHEREUM_GOERLI_RPC_URL;
    delete process.env.ETHEREUM_SEPOLIA_RPC_URL;
    jest.resetModules();
  });

  afterEach(() => {
    providers.forEach((provider) => provider.destroy());
    providers.clear();
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  function loadFactory() {
    const { getEthereumRpcProvider } = require('./ethereum-rpc-provider') as {
      getEthereumRpcProvider: (chainId?: number) => JsonRpcProvider;
    };
    return (chainId?: number) => {
      const provider = getEthereumRpcProvider(chainId);
      providers.add(provider);
      return provider;
    };
  }

  it('imports without configuration and reads configuration only when called', () => {
    const factory = loadFactory();
    expect(() => factory()).toThrow('ETHEREUM_RPC_URL');
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    expect(factory()._getConnection().url).toBe('https://rpc.example.test');
  });

  it('caches by chain and URL without requiring Alchemy credentials', () => {
    const factory = loadFactory();
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    process.env.ETHEREUM_SEPOLIA_RPC_URL = process.env.ETHEREUM_RPC_URL;
    const mainnet = factory();
    expect(factory(1)).toBe(mainnet);
    expect(factory(11155111)).not.toBe(mainnet);
    process.env.ETHEREUM_RPC_URL = 'https://replacement.example.test';
    expect(factory()).not.toBe(mainnet);
    expect(factory()._getConnection().url).toBe(
      'https://replacement.example.test'
    );
    delete process.env.ETHEREUM_RPC_URL;
    expect(() => factory()).toThrow('ETHEREUM_RPC_URL');
  });

  it.each([1, 5, 11155111])(
    'keeps chain-ID verification for chain %s',
    async (chainId) => {
      const factory = loadFactory();
      const { getEthereumRpcEnvName } = require('./ethereum-rpc.config') as {
        getEthereumRpcEnvName: (chainId: number) => string;
      };
      process.env[getEthereumRpcEnvName(chainId)] = 'https://rpc.example.test';
      const provider = factory(chainId);
      const send = jest
        .spyOn(provider, '_send')
        .mockImplementation(async (payload) => {
          const requests = Array.isArray(payload) ? payload : [payload];
          return requests.map((request) => ({
            id: request.id,
            result: `0x${chainId.toString(16)}`
          }));
        });
      expect((await provider.getNetwork()).chainId).toBe(BigInt(chainId));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'eth_chainId' })
      );
      send.mockImplementation(async (payload) => {
        const requests = Array.isArray(payload) ? payload : [payload];
        return requests.map((request) => ({ id: request.id, result: '0x89' }));
      });
      await expect(provider.getNetwork()).rejects.toThrow(/network changed/);
    }
  );

  it('rejects a wrong-chain endpoint on the first network check', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://wrong-chain.example.test';
    const provider = loadFactory()();
    jest.spyOn(provider, '_send').mockImplementation(async (payload) => {
      const requests = Array.isArray(payload) ? payload : [payload];
      return requests.map((request) => ({
        id: request.id,
        result: '0xaa36a7'
      }));
    });
    await expect(provider.getNetwork()).rejects.toThrow(/network changed/);
  });

  it('does not repoint the existing providers during the foundation phase', () => {
    process.env.ALCHEMY_API_KEY = 'test-legacy-key';
    process.env.ETHEREUM_RPC_URL = 'https://new.example.test';
    const { getRpcProvider, get6529RpcProvider } =
      require('../rpc-provider') as {
        getRpcProvider: () => JsonRpcProvider;
        get6529RpcProvider: () => JsonRpcProvider;
      };
    const legacy = getRpcProvider();
    const internal = get6529RpcProvider();
    providers.add(legacy);
    providers.add(internal);
    expect(legacy._getConnection().url).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/test-legacy-key'
    );
    expect(internal._getConnection().url).toBe('https://rpc1.6529.io');
    expect(loadFactory()()).not.toBe(legacy);
  });
});
