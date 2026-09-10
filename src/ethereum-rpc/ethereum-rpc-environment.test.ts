import type { JsonRpcProvider } from 'ethers';

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManager: jest.fn()
}));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@/logging', () => ({
  Logger: {
    get: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
  }
}));

describe('Ethereum RPC existing environment wiring', () => {
  const originalEnv = process.env;
  const providers = new Set<JsonRpcProvider>();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.ETHEREUM_SEPOLIA_RPC_URL;
    delete process.env.ETHEREUM_GOERLI_RPC_URL;
  });

  afterEach(() => {
    providers.forEach((provider) => provider.destroy());
    providers.clear();
    process.env = originalEnv;
  });

  function readProviderUrl(chainId = 1) {
    const { getEthereumRpcProvider } = require('./ethereum-rpc-provider') as {
      getEthereumRpcProvider: (chainId: number) => JsonRpcProvider;
    };
    const provider = getEthereumRpcProvider(chainId);
    providers.add(provider);
    return provider._getConnection().url;
  }

  it.each(['eu-west-1', 'us-east-1'])(
    'uses the existing regional shared secret in %s without per-service URL wiring',
    async (region) => {
      process.env.AWS_REGION = region;
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'discoverEnsLoop';
      process.env.ETHEREUM_RPC_URL = 'https://old-environment.example.test';
      const values = {
        NODE_ENV: 'production',
        ALCHEMY_API_KEY: 'retained-indexed-key',
        ETHEREUM_RPC_URL: 'https://mainnet.example.test/v2/private-key',
        ETHEREUM_SEPOLIA_RPC_URL: 'https://sepolia.example.test',
        ETHEREUM_GOERLI_RPC_URL: 'https://goerli.example.test'
      };
      const getSecretValue = jest.fn().mockResolvedValue({
        SecretString: JSON.stringify(values)
      });
      const { SecretsManager } = jest.requireMock(
        '@aws-sdk/client-secrets-manager'
      );
      SecretsManager.mockImplementation(() => ({ getSecretValue }));
      const { prepEnvironment } = require('@/env') as {
        prepEnvironment: () => Promise<void>;
      };

      await prepEnvironment();

      expect(SecretsManager).toHaveBeenCalledWith(
        expect.objectContaining({ region })
      );
      expect(getSecretValue).toHaveBeenCalledWith({ SecretId: 'prod/lambdas' });
      expect(readProviderUrl()).toBe(values.ETHEREUM_RPC_URL);
      expect(readProviderUrl(11155111)).toBe(values.ETHEREUM_SEPOLIA_RPC_URL);
      expect(readProviderUrl(5)).toBe(values.ETHEREUM_GOERLI_RPC_URL);
      expect(process.env.ALCHEMY_API_KEY).toBe('retained-indexed-key');
      const { Logger } = jest.requireMock('@/logging');
      const logged = JSON.stringify(
        Logger.get.mock.results.map(
          (result: { value: { info: jest.Mock } }) =>
            result.value.info.mock.calls
        )
      );
      expect(logged).not.toContain('private-key');
      expect(logged).not.toContain('retained-indexed-key');
    }
  );

  it('uses the repo-root local environment loader before provider construction', async () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.NODE_ENV = 'development';
    const dotenv = jest.requireMock('dotenv');
    dotenv.config.mockImplementation(() => {
      process.env.ETHEREUM_RPC_URL = 'http://localhost:8545';
    });
    const { prepEnvironment } = require('@/env') as {
      prepEnvironment: () => Promise<void>;
    };
    await prepEnvironment();
    expect(dotenv.config).toHaveBeenCalledWith({
      path: expect.stringMatching(/\/\.env\.development$/)
    });
    expect(readProviderUrl()).toBe('http://localhost:8545');
    expect(
      jest.requireMock('@aws-sdk/client-secrets-manager').SecretsManager
    ).not.toHaveBeenCalled();
  });

  it('does not require the new configuration during existing secret loading', async () => {
    const { SecretsManager } = jest.requireMock(
      '@aws-sdk/client-secrets-manager'
    );
    SecretsManager.mockImplementation(() => ({
      getSecretValue: jest.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          NODE_ENV: 'production',
          ALCHEMY_API_KEY: 'legacy-key'
        })
      })
    }));
    const { loadSecrets } = require('@/env') as {
      loadSecrets: () => Promise<void>;
    };
    await expect(loadSecrets()).resolves.toBeUndefined();
    expect(() => readProviderUrl()).toThrow('ETHEREUM_RPC_URL is required');
    expect(process.env.ALCHEMY_API_KEY).toBe('legacy-key');
  });
});
