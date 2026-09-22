import { getWalletFromEns } from './ens-forward';
import { getEthereumRpcClient } from './ethereum-rpc-client';
import * as mcache from 'memory-cache';

jest.mock('./ethereum-rpc-client', () => ({ getEthereumRpcClient: jest.fn() }));

describe('forward ENS through ordinary RPC', () => {
  const resolveName = jest.fn();
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    mcache.clear();
    process.env = { ...originalEnv };
    delete process.env.ALCHEMY_API_KEY;
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue({ resolveName } as unknown as ReturnType<
        typeof getEthereumRpcClient
      >);
  });
  afterEach(() => {
    mcache.clear();
    process.env = originalEnv;
  });
  it('normalizes and caches a valid result without requiring an indexed client', async () => {
    const address = '0x' + 'AB'.repeat(20);
    resolveName.mockResolvedValue(address);
    await expect(getWalletFromEns('Example.eth')).resolves.toBe(
      address.toLowerCase()
    );
    await expect(getWalletFromEns('example.eth')).resolves.toBe(
      address.toLowerCase()
    );
    expect(resolveName).toHaveBeenCalledTimes(1);
    expect(resolveName).toHaveBeenCalledWith('Example.eth');
  });
  it('preserves missing-name and non-ENS results', async () => {
    resolveName.mockResolvedValue(null);
    await expect(getWalletFromEns('missing.eth')).resolves.toBeNull();
    await expect(getWalletFromEns('not-an-ens-name')).resolves.toBeNull();
    expect(resolveName).toHaveBeenCalledTimes(1);
  });
});
