import { getRpcUrl } from '@/alchemy';
import { simulateStoredMarketBatch } from '@/marketplace/market-batch-preflight-rpc';
import { marketBatchFixture } from '@/marketplace/market-batch.test-fixture';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { MarketValidationError } from '@/marketplace/provider.types';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';

jest.mock('@/alchemy', () => ({
  getRpcUrl: jest.fn(() => 'https://rpc.example.invalid/ethereum')
}));

const NOW = 1_800_000_000;
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK = {
  number: '0x64',
  hash: HASH,
  timestamp: `0x${NOW.toString(16)}`
};
const UNAVAILABLE = {
  code: 'PROVIDER_UNAVAILABLE',
  message: 'The batch checks could not finish. Try again.'
};

function preparedBatch(): MarketBatchPrepared {
  const { intent, terms } = marketBatchFixture();
  const gas = {
    gas_limit: '700000',
    max_fee_per_gas: '100',
    gas_reserve_wei: '70000000'
  };
  return {
    intent,
    approvalTransactions: [],
    transaction: {
      kind: 'TRANSACTION',
      chainId: 1,
      from: intent.wallet,
      to: MARKET_SEAPORT,
      value: intent.totalWei,
      data: `0x${'12'.repeat(11_140)}`,
      purpose: 'FULFILL',
      gas
    },
    gas,
    snapshot: {
      block_number: 99,
      block_hash: `0x${'cd'.repeat(32)}`,
      block_timestamp: NOW - 12
    },
    feePolicyVersion: 'test',
    mirrorTerms: terms,
    reviewOrders: [],
    validUntil: (NOW + 90) * 1000
  };
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

describe('stored batch RPC simulation boundary', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let controller: AbortController;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    jest.replaceProperty(process, 'env', {
      ...process.env,
      ALCHEMY_API_KEY: 'test-only'
    });
    controller = new AbortController();
    fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async () => {
      throw new Error('Unexpected mocked RPC request');
    });
    jest.mocked(getRpcUrl).mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  function successResponses(canonical: unknown = BLOCK) {
    fetchMock
      .mockResolvedValueOnce(rpcResponse(BLOCK))
      .mockResolvedValueOnce(rpcResponse('0x1234'))
      .mockResolvedValueOnce(rpcResponse('0x8affd'))
      .mockResolvedValueOnce(rpcResponse(canonical));
  }

  test('sends only the exact stored transaction to the fixed provider at one canonical block', async () => {
    successResponses();
    const prepared = preparedBatch();
    const before = JSON.stringify(prepared);
    await expect(
      simulateStoredMarketBatch(prepared, controller.signal)
    ).resolves.toEqual({
      block_number: 100,
      block_hash: HASH,
      block_timestamp: NOW,
      estimated_gas: '569341'
    });
    const transaction = {
      from: prepared.transaction.from,
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      value: '0x12c'
    };
    const requests = [
      ['eth_getBlockByNumber', ['latest', false]],
      ['eth_call', [transaction, '0x64']],
      ['eth_estimateGas', [transaction, '0x64']],
      ['eth_getBlockByNumber', ['0x64', false]]
    ];
    expect(fetchMock).toHaveBeenCalledTimes(requests.length);
    requests.forEach(([method, params], index) => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        index + 1,
        'https://rpc.example.invalid/ethereum',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          redirect: 'error',
          signal: controller.signal
        }
      );
    });
    expect(getRpcUrl).toHaveBeenCalledTimes(4);
    expect(getRpcUrl).toHaveBeenCalledWith(1);
    expect(JSON.stringify(prepared)).toBe(before);
  });

  test.each([
    ['stale', { ...BLOCK, timestamp: `0x${(NOW - 121).toString(16)}` }],
    ['future', { ...BLOCK, timestamp: `0x${(NOW + 31).toString(16)}` }],
    ['unsafe height', { ...BLOCK, number: '0x20000000000000' }],
    ['unsafe timestamp', { ...BLOCK, timestamp: '0x20000000000000' }],
    ['zero height', { ...BLOCK, number: '0x0' }],
    ['noncanonical quantity', { ...BLOCK, number: '0x064' }],
    ['missing hash', { ...BLOCK, hash: null }],
    ['older prepared height', { ...BLOCK, number: '0x62' }],
    [
      'older prepared timestamp',
      { ...BLOCK, timestamp: `0x${(NOW - 13).toString(16)}` }
    ]
  ])(
    'rejects a %s snapshot before exporting transaction data',
    async (_label, block) => {
      fetchMock.mockResolvedValueOnce(rpcResponse(block));
      await expect(
        simulateStoredMarketBatch(preparedBatch(), controller.signal)
      ).rejects.toMatchObject(UNAVAILABLE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    ['hash', { ...BLOCK, hash: `0x${'ef'.repeat(32)}` }],
    ['height', { ...BLOCK, number: '0x65' }],
    ['timestamp', { ...BLOCK, timestamp: `0x${(NOW + 1).toString(16)}` }]
  ])(
    'rejects a changed canonical %s after simulation',
    async (_label, block) => {
      successResponses(block);
      await expect(
        simulateStoredMarketBatch(preparedBatch(), controller.signal)
      ).rejects.toMatchObject(UNAVAILABLE);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );

  test.each(['0x0', '0x1000001', '123', '0x01', null])(
    'rejects invalid or excessive estimated gas %s',
    async (gas) => {
      fetchMock
        .mockResolvedValueOnce(rpcResponse(BLOCK))
        .mockResolvedValueOnce(rpcResponse('0x'))
        .mockResolvedValueOnce(rpcResponse(gas));
      await expect(
        simulateStoredMarketBatch(preparedBatch(), controller.signal)
      ).rejects.toMatchObject(UNAVAILABLE);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  );

  test.each(['0x1', 'not hex', null, { data: '0x' }])(
    'rejects a malformed call result %j before estimating',
    async (result) => {
      fetchMock
        .mockResolvedValueOnce(rpcResponse(BLOCK))
        .mockResolvedValueOnce(rpcResponse(result));
      await expect(
        simulateStoredMarketBatch(preparedBatch(), controller.signal)
      ).rejects.toMatchObject(UNAVAILABLE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  test.each([
    { jsonrpc: '2.0', id: 2, result: BLOCK },
    { jsonrpc: '1.0', id: 1, result: BLOCK },
    { jsonrpc: '2.0', id: 1 },
    [{ jsonrpc: '2.0', id: 1, result: BLOCK }]
  ])('rejects an unbound JSON-RPC response envelope', async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
    await expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([3, -32000])(
    'sanitizes contract revert code %s and stops the batch',
    async (code) => {
      fetchMock.mockResolvedValueOnce(rpcResponse(BLOCK)).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code,
              message: 'execution reverted: private-provider-detail',
              data: 'private-authorization'
            }
          })
        )
      );
      await expect(
        simulateStoredMarketBatch(preparedBatch(), controller.signal)
      ).rejects.toMatchObject({
        code: 'ORDER_MISMATCH',
        message:
          'The complete batch can no longer be executed. Review the listings again.'
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  test('never exposes provider errors, request data or transport URLs', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error('private-authorization https://provider.invalid/private-key')
    );
    const error = await simulateStoredMarketBatch(
      preparedBatch(),
      controller.signal
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MarketValidationError);
    expect(error).toMatchObject(UNAVAILABLE);
    expect(JSON.stringify(error)).not.toContain('private-');
  });

  test.each([
    new Response('private-provider-html', { status: 403 }),
    new Response('{broken-private-json'),
    new Response(new Uint8Array([0xc3, 0x28])),
    new Response(null),
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32005, message: 'private-quota-detail' }
      })
    )
  ])('fails closed on an unusable provider response', async (response) => {
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('caps streamed response bytes and cancels the oversized body', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(2_000_001));
      },
      cancel
    });
    fetchMock.mockResolvedValueOnce(new Response(body));
    await expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not contact a provider without configured credentials', async () => {
    delete process.env.ALCHEMY_API_KEY;
    await expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRpcUrl).not.toHaveBeenCalled();
  });

  test('does not start any request after cancellation', async () => {
    controller.abort();
    await expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('propagates cancellation to an in-flight request and starts no subsequent request', async () => {
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    fetchMock.mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private-abort-details')),
            { once: true }
          );
          requestStarted();
        })
    );
    const rejected = expect(
      simulateStoredMarketBatch(preparedBatch(), controller.signal)
    ).rejects.toMatchObject(UNAVAILABLE);
    await started;
    controller.abort();
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
