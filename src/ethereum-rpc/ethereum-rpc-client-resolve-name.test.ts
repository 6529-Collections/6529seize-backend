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

  it('does not surface a late lookup failure after the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      jest.spyOn(provider, 'resolveName').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('late failure')),
              ENS_RESOLVE_NAME_TIMEOUT_MS * 2
            );
          })
      );
      const result = getEthereumRpcClient()
        .resolveName('late.eth')
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(ENS_RESOLVE_NAME_TIMEOUT_MS);
      expect(await result).toMatchObject({ code: ENS_RESOLVE_DEADLINE_CODE });
      await jest.advanceTimersByTimeAsync(ENS_RESOLVE_NAME_TIMEOUT_MS * 2);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears the deadline timer when the lookup fails first', async () => {
    jest
      .spyOn(provider, 'resolveName')
      .mockRejectedValue(new Error('not retried'));
    const client = getEthereumRpcClient();
    const timersBefore = jest.getTimerCount();
    await expect(client.resolveName('broken.eth')).rejects.toThrow(
      'not retried'
    );
    expect(jest.getTimerCount()).toBe(timersBefore);
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
