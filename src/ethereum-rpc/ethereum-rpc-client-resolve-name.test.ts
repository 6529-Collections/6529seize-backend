import { JsonRpcProvider } from 'ethers';
import {
  ENS_RESOLVE_DEADLINE_CODE,
  ENS_RESOLVE_NAME_TIMEOUT_MS,
  getEthereumRpcClient
} from './ethereum-rpc-client';
import { getEthereumRpcProvider } from './ethereum-rpc-provider';

jest.mock('axios-retry', () => ({
  __esModule: true,
  default: { exponentialDelay: () => 1000 }
}));

describe('EthereumRpcClient.resolveName deadline', () => {
  const originalEnv = process.env;
  let provider: JsonRpcProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env = {
      ...originalEnv,
      ETHEREUM_RPC_URL: 'https://rpc.example.test'
    };
    provider = getEthereumRpcProvider();
  });

  afterEach(() => {
    provider.destroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = originalEnv;
  });

  it('resolves through the shared provider, which has CCIP-Read off', async () => {
    const resolve = jest
      .spyOn(provider, 'resolveName')
      .mockResolvedValue('0x' + '11'.repeat(20));
    await expect(getEthereumRpcClient().resolveName('a.eth')).resolves.toBe(
      '0x' + '11'.repeat(20)
    );
    expect(resolve).toHaveBeenCalledWith('a.eth');
    expect(provider.disableCcipRead).toBe(true);
  });

  it('rejects a stalled lookup at the deadline', async () => {
    jest.spyOn(provider, 'resolveName').mockReturnValue(new Promise(() => {}));
    const result = getEthereumRpcClient()
      .resolveName('slow.eth')
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(ENS_RESOLVE_NAME_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: ENS_RESOLVE_DEADLINE_CODE });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops retrying transient failures once the deadline has passed', async () => {
    const resolve = jest
      .spyOn(provider, 'resolveName')
      .mockRejectedValue(Object.assign(new Error('timeout'), { status: 503 }));
    const result = getEthereumRpcClient()
      .resolveName('flaky.eth', 2500)
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: ENS_RESOLVE_DEADLINE_CODE });
    const callsAtDeadline = resolve.mock.calls.length;
    expect(callsAtDeadline).toBeLessThanOrEqual(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(resolve).toHaveBeenCalledTimes(callsAtDeadline);
    expect(jest.getTimerCount()).toBe(0);
  });
});
