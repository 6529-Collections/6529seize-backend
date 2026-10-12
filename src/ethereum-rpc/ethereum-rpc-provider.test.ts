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

  /** Track real providers from an isolated factory so teardown releases them. */
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

  it('replaces a destroyed cached provider and reuses its live replacement', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.test';
    const factory = loadFactory();
    const original = factory();
    original.destroy();
    expect(original.destroyed).toBe(true);

    const replacement = factory();
    expect(replacement).not.toBe(original);
    expect(replacement.destroyed).toBe(false);
    expect(factory()).toBe(replacement);
    expect(replacement._getConnection().url).toBe(process.env.ETHEREUM_RPC_URL);
    jest.spyOn(replacement, '_send').mockImplementation(async (payload) => {
      const requests = Array.isArray(payload) ? payload : [payload];
      return requests.map((request) => ({ id: request.id, result: '0x1' }));
    });
    expect((await replacement.getNetwork()).chainId).toBe(BigInt(1));
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

  it('uses the configured endpoint for code and contract reads without an Alchemy key', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://contract-rpc.example.test';
    const provider = loadFactory()();
    const { Contract } = require('ethers') as typeof import('ethers');
    const send = jest
      .spyOn(provider, '_send')
      .mockImplementation(async (payload) => {
        const requests = Array.isArray(payload) ? payload : [payload];
        return requests.map((request) => {
          const results: Record<string, string> = {
            eth_chainId: '0x1',
            eth_getCode: '0x6000',
            eth_call: '0x' + '2a'.padStart(64, '0')
          };
          if (!(request.method in results))
            throw new Error('Unexpected RPC method');
          return { id: request.id, result: results[request.method] };
        });
      });
    const address = '0x' + '11'.repeat(20);
    const contract = new Contract(
      address,
      ['function totalSupply() view returns (uint256)'],
      provider
    );
    await expect(provider.getCode(address)).resolves.toBe('0x6000');
    await expect(contract.totalSupply()).resolves.toBe(BigInt(42));
    expect(provider._getConnection().url).toBe(process.env.ETHEREUM_RPC_URL);
    expect(send).toHaveBeenCalled();
  });

  it('routes the existing factory through the canonical URL without an Alchemy key', () => {
    process.env.ETHEREUM_RPC_URL = 'https://new.example.test';
    const { getRpcProvider } = require('../rpc-provider') as {
      getRpcProvider: () => JsonRpcProvider;
    };
    const provider = getRpcProvider();
    providers.add(provider);
    expect(provider._getConnection().url).toBe('https://new.example.test');
    expect(loadFactory()()).toBe(provider);
  });
});
