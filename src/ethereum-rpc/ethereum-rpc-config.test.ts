import {
  getEthereumRpcEnvName,
  getEthereumRpcUrl
} from '@/ethereum-rpc/ethereum-rpc.config';

describe('Ethereum RPC configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.ETHEREUM_GOERLI_RPC_URL;
    delete process.env.ETHEREUM_SEPOLIA_RPC_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    [1, 'ETHEREUM_RPC_URL'],
    [5, 'ETHEREUM_GOERLI_RPC_URL'],
    [11155111, 'ETHEREUM_SEPOLIA_RPC_URL']
  ] as const)('selects chain %s explicitly', (chainId, envName) => {
    process.env[envName] = 'https://rpc.example.test/v2/key?token=value';
    expect(getEthereumRpcEnvName(chainId)).toBe(envName);
    expect(getEthereumRpcUrl(chainId)).toBe(process.env[envName]);
  });

  it.each([
    'https://rpc.example.test/v2/key',
    'http://localhost:8545',
    'http://[::1]:8545',
    'https://user:password@rpc.example.test/rpc?key=a%2Fb'
  ])('accepts a complete HTTP(S) URL without altering it', (url) => {
    process.env.ETHEREUM_RPC_URL = url;
    expect(getEthereumRpcUrl()).toBe(url);
  });

  it.each([
    '',
    ' ',
    '\n',
    'https://',
    'https:rpc.example.test',
    'https:/rpc.example.test',
    'https:///rpc.example.test',
    'ws://rpc.example.test',
    'file:///rpc',
    'https://rpc.example.test:99999',
    ' https://rpc.example.test',
    'https://rpc.example.test\n',
    'https://rpc.example.test/pri\nvate',
    'https://rpc.example.test/path with spaces',
    'https://rpc.example.test\\private',
    'https://rpc.example.test/#private'
  ])('rejects missing or malformed configuration (%j)', (url) => {
    process.env.ETHEREUM_RPC_URL = url;
    expect(() => getEthereumRpcUrl()).toThrow(/ETHEREUM_RPC_URL/);
  });

  it('does not leak a rejected value in the error or its cause', () => {
    process.env.ETHEREUM_RPC_URL = 'https://private-secret:bad-port';
    try {
      getEthereumRpcUrl();
      throw new Error('Expected URL validation to reject the value');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe(
        'Error: ETHEREUM_RPC_URL must be a complete HTTP(S) URL'
      );
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('never derives a missing URL from Alchemy credentials or another chain', () => {
    process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
    expect(() => getEthereumRpcUrl()).toThrow('ETHEREUM_RPC_URL is required');
    process.env.ETHEREUM_RPC_URL = 'https://mainnet.example.test';
    expect(() => getEthereumRpcUrl(5)).toThrow('ETHEREUM_GOERLI_RPC_URL');
    expect(() => getEthereumRpcUrl(11155111)).toThrow(
      'ETHEREUM_SEPOLIA_RPC_URL'
    );
    expect(getEthereumRpcUrl()).toBe('https://mainnet.example.test');
  });

  it.each([0, -1, 1.5, 137, 17000, 560048, NaN, Infinity])(
    'rejects unsupported chain %s even when mainnet is configured',
    (chainId) => {
      process.env.ETHEREUM_RPC_URL = 'https://mainnet.example.test';
      expect(() => getEthereumRpcUrl(chainId)).toThrow(
        'Unsupported Ethereum RPC chain ID'
      );
    }
  );
});
