import {
  AbiCoder,
  Contract,
  JsonRpcApiProvider,
  JsonRpcProvider,
  JsonRpcPayload
} from 'ethers';
import { Logger } from '@/logging';
import {
  isTransientRpcInternalError,
  withTransientRpcRetry
} from '@/ethereum-rpc/transient-rpc-retry';

jest.mock('@/logging', () => {
  const logger = { warn: jest.fn(), info: jest.fn() };
  return { Logger: { get: () => logger } };
});

const logger = Logger.get('ETHEREUM_RPC_RETRY');
const internalError = { code: -32000, message: 'Internal error' };

function ethersError(method: string, rpcError = internalError): Error {
  const provider = new JsonRpcProvider('https://rpc.example.test', 1);
  try {
    return provider.getRpcError(
      {
        id: 1,
        jsonrpc: '2.0',
        method,
        params:
          method === 'eth_call'
            ? [
                {
                  to: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
                  data: '0x0e89341c'
                },
                'latest'
              ]
            : []
      },
      { id: 1, error: rpcError }
    );
  } finally {
    provider.destroy();
  }
}

describe('transient RPC retries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['eth_call', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_chainId'])(
    'recovers from the real ethers error envelope for %s after pausing',
    async (method) => {
      const error = ethersError(method);
      const read = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('recovered');
      const result = withTransientRpcRetry(read, method);

      await jest.advanceTimersByTimeAsync(249);
      expect(read).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toBe('recovered');
      expect(read).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith({
        event: 'rpc_read_recovered',
        operation: method,
        retries: 1
      });
    }
  );

  it('exhausts three increasing delays and propagates the original error', async () => {
    const error = ethersError('eth_call');
    const read = jest.fn<Promise<string>, []>().mockRejectedValue(error);
    const rejection = expect(
      withTransientRpcRetry(read, 'nfts.uri')
    ).rejects.toBe(error);

    for (const delay of [250, 750, 2000]) {
      const calls = read.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(read).toHaveBeenCalledTimes(calls);
      await jest.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(calls + 1);
    }
    await rejection;
    expect(read).toHaveBeenCalledTimes(4);
    expect(Date.now()).toBe(3000);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('bounds jitter to 20 percent and total deliberate waiting to 3.6 seconds', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99999);
    const error = ethersError('eth_getLogs');
    const rejection = expect(
      withTransientRpcRetry(
        jest.fn().mockRejectedValue(error),
        'nextgen.getLogs'
      )
    ).rejects.toBe(error);

    await jest.runAllTimersAsync();
    await rejection;
    expect(Date.now()).toBe(3600);
    expect(
      jest.mocked(logger.warn).mock.calls.map(([value]) => value.delay_ms)
    ).toEqual([300, 900, 2400]);
  });

  it.each([
    null,
    undefined,
    'Internal error',
    new Error('Internal error'),
    { code: 'CALL_EXCEPTION', shortMessage: 'missing revert data' },
    { code: 'NETWORK_ERROR', event: 'changed' },
    { code: -32000, message: 'execution reverted' },
    { code: -32602, message: 'block range extends beyond current head block' },
    { info: { error: { code: -32000, message: 'insufficient funds' } } },
    { info: { error: internalError }, data: '0x08c379a0' },
    { info: { error: internalError }, reason: 'invalid token' },
    { info: { error: internalError }, revert: { name: 'InvalidToken' } }
  ])('propagates non-transient errors immediately: %j', async (error) => {
    const read = jest.fn<Promise<string>, []>().mockRejectedValue(error);
    await expect(withTransientRpcRetry(read, 'read')).rejects.toBe(error);
    expect(isTransientRpcInternalError(error)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves a genuine contract revert produced by ethers', async () => {
    const error = ethersError('eth_call', {
      code: 3,
      message: 'execution reverted: invalid token'
    });
    const read = jest.fn<Promise<string>, []>().mockRejectedValue(error);
    await expect(withTransientRpcRetry(read, 'nfts.uri')).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops retrying if a later attempt returns a different permanent error', async () => {
    const permanent = new Error('invalid token');
    const read = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(ethersError('eth_call'))
      .mockRejectedValueOnce(permanent);
    const rejection = expect(withTransientRpcRetry(read, 'read')).rejects.toBe(
      permanent
    );
    await jest.runAllTimersAsync();
    await rejection;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not log RPC credentials or payloads from the error', async () => {
    const error = Object.assign(new Error('missing revert data'), {
      info: { error: internalError },
      message: 'https://rpc.example.test/v2/private-key',
      transaction: { data: 'private-payload' }
    });
    const read = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const result = withTransientRpcRetry(read, 'nfts.uri');
    await jest.runAllTimersAsync();
    await result;
    const logs = JSON.stringify([
      jest.mocked(logger.warn).mock.calls,
      jest.mocked(logger.info).mock.calls
    ]);
    expect(logs).not.toContain('private-key');
    expect(logs).not.toContain('private-payload');
  });

  it('returns successful reads without timers or recovery logs', async () => {
    await expect(withTransientRpcRetry(async () => 42, 'read')).resolves.toBe(
      42
    );
    expect(jest.getTimerCount()).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('also handles a synchronous provider failure', async () => {
    const read = jest
      .fn<Promise<number>, []>()
      .mockImplementationOnce(() => {
        throw ethersError('eth_chainId');
      })
      .mockResolvedValueOnce(42);
    const result = withTransientRpcRetry(read, 'read');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toBe(42);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retries a real ethers NFT URI read through its provider transport', async () => {
    const provider = new JsonRpcProvider('https://rpc.example.test', 1);
    const uri = 'https://metadata.example.test/571.json';
    let contractCalls = 0;
    const transport: JsonRpcApiProvider = provider;
    jest
      .spyOn(transport, '_send')
      .mockImplementation(
        async (payload: JsonRpcPayload | JsonRpcPayload[]) => {
          const requests = Array.isArray(payload) ? payload : [payload];
          return requests.map((request) => {
            if (request.method === 'eth_chainId') {
              return { id: request.id, result: '0x1' };
            }
            if (request.method !== 'eth_call') {
              throw new Error(`Unexpected method ${request.method}`);
            }
            contractCalls++;
            return contractCalls === 1
              ? { id: request.id, error: internalError }
              : {
                  id: request.id,
                  result: AbiCoder.defaultAbiCoder().encode(['string'], [uri])
                };
          });
        }
      );
    try {
      const contract = new Contract(
        '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
        ['function uri(uint256) view returns (string)'],
        provider
      );
      const result = withTransientRpcRetry<string>(
        () => contract.uri(571),
        'nfts.discover.uri'
      );
      await jest.runAllTimersAsync();
      await expect(result).resolves.toBe(uri);
      expect(contractCalls).toBe(2);
    } finally {
      provider.destroy();
    }
  });
});
