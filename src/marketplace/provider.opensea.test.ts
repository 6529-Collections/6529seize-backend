import { MarketTradeIntent } from '@/marketplace/provider.types';
import { TypedDataEncoder, Wallet } from 'ethers';
import {
  buildMarketOrder,
  prepareMarketCancel,
  MARKET_SEAPORT_INTERFACE
} from '@/marketplace/seaport.builder';
import {
  OpenSeaMarketplaceProvider,
  OPENSEA_REQUEST_TIMEOUT_MS,
  marketFeesForTotal,
  describeMarketOrder
} from '@/marketplace/provider.opensea';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import * as quoteValidation from '@/marketplace/quote-validation';
import {
  MARKET_SEAPORT,
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';

const maker = '0x1111111111111111111111111111111111111111';
const buyer = '0x2222222222222222222222222222222222222222';
const gift = '0x3333333333333333333333333333333333333333';
const intent: MarketTradeIntent = {
  kind: 'LIST',
  chainId: 1,
  wallet: maker,
  recipient: maker,
  asset: {
    contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
    tokenId: '56',
    standard: 'ERC1155'
  },
  quantity: '2',
  currency: MARKET_ZERO_ADDRESS,
  maxTotalWei: '200',
  minNetWei: '198',
  fees: [{ recipient: gift, amountWei: '2' }],
  includeOptionalCreatorFees: false,
  startTime: '1700000000',
  endTime: '1900000000'
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }
  });

describe('OpenSea boundary', () => {
  it('aborts in-flight quotes when the complete batch deadline expires without exposing provider inputs', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const mock = jest.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init.signal;
          requestSignal!.addEventListener(
            'abort',
            () => reject(new Error('synthetic-private-provider-body')),
            { once: true }
          );
        })
    );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'synthetic-placeholder',
      fetch: mock,
      signal: controller.signal
    });
    const request = provider.getOrder({
      protocolAddress: MARKET_SEAPORT,
      orderHash: `0x${'11'.repeat(32)}`
    });
    const failure = expect(request).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The marketplace provider could not complete the request.'
    });
    controller.abort();
    await failure;
    expect(requestSignal?.aborted).toBe(true);
  });
  it('does not turn unexpected discovery validation errors into a successful empty market', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const mock = jest
      .fn()
      .mockResolvedValueOnce(response({ collection: 'thememes6529' }))
      .mockResolvedValueOnce(
        response({
          chain: 'ethereum',
          protocol_address: MARKET_SEAPORT,
          order_hash: order.orderHash,
          protocol_data: { parameters: order.components },
          remaining_quantity: '2'
        })
      );
    const unexpected = new TypeError('unexpected validator failure');
    const validate = jest
      .spyOn(quoteValidation, 'validateMarketOrder')
      .mockImplementation(() => {
        throw unexpected;
      });
    try {
      const provider = new OpenSeaMarketplaceProvider({
        apiKey: 'test-placeholder',
        fetch: mock
      });
      await expect(
        provider.discoverOrders(intent.asset, 'LISTING')
      ).rejects.toBe(unexpected);
    } finally {
      validate.mockRestore();
    }
  });
  it.each([
    'timestamp-text',
    'timestamp-overflow',
    'hex-amount',
    'zero-prefixed-amount',
    'whitespace-amount',
    'bad-token-id',
    'foreign-token',
    'foreign-currency',
    'foreign-protocol',
    'foreign-chain',
    'bad-address'
  ])(
    'excludes hostile %s provider orders before exposing discovery economics',
    async (failure) => {
      const order = buildMarketOrder(intent, '0', '1').order;
      const raw = {
        chain: 'ethereum',
        protocol_address: MARKET_SEAPORT,
        order_hash: order.orderHash,
        protocol_data: { parameters: structuredClone(order.components) },
        remaining_quantity: '2'
      };
      const c = raw.protocol_data.parameters;
      if (failure === 'timestamp-text') c.endTime = 'NaN';
      if (failure === 'timestamp-overflow') c.endTime = '8640000000001';
      if (failure === 'hex-amount') c.consideration[0].startAmount = '0xc6';
      if (failure === 'zero-prefixed-amount')
        c.consideration[0].startAmount = '0198';
      if (failure === 'whitespace-amount')
        c.consideration[0].startAmount = ' 198';
      if (failure === 'bad-token-id') c.offer[0].identifierOrCriteria = '1.5';
      if (failure === 'foreign-token') c.offer[0].token = buyer;
      if (failure === 'foreign-currency') c.consideration[0].token = buyer;
      if (failure === 'foreign-protocol') raw.protocol_address = buyer;
      if (failure === 'foreign-chain') raw.chain = 'polygon';
      if (failure === 'bad-address') c.offerer = 'not-an-address';
      if (
        ['timestamp-overflow', 'foreign-token', 'foreign-currency'].includes(
          failure
        )
      )
        raw.order_hash = TypedDataEncoder.hashStruct(
          'OrderComponents',
          SEAPORT_ORDER_TYPES,
          c
        );
      const mock = jest
        .fn()
        .mockResolvedValueOnce(response({ collection: 'thememes6529' }))
        .mockResolvedValueOnce(response(raw));
      const provider = new OpenSeaMarketplaceProvider({
        apiKey: 'test-placeholder',
        fetch: mock
      });
      await expect(
        provider.discoverOrders(intent.asset, 'LISTING')
      ).resolves.toEqual([]);
      expect(mock).toHaveBeenCalledTimes(2);
    }
  );
  it('bounds Date conversion without restricting raw Seaport components used to cancel long-lived orders', async () => {
    const longIntent = { ...intent, endTime: '8640000000001' };
    const order = buildMarketOrder(longIntent, '0', '1').order;
    const mock = jest.fn();
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    await expect(provider.prepareOrder(longIntent)).rejects.toMatchObject({
      code: 'ORDER_MISMATCH'
    });
    expect(mock).not.toHaveBeenCalled();
    expect(() =>
      describeMarketOrder(
        {
          identity: {
            protocolAddress: MARKET_SEAPORT,
            orderHash: order.orderHash
          },
          components: order.components,
          signature: '0x'
        },
        intent.asset,
        'LISTING'
      )
    ).toThrow(/timestamp/);
    expect(order.components.endTime).toBe(longIntent.endTime);
    expect(
      prepareMarketCancel(
        maker,
        { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash },
        order.components
      ).purpose
    ).toBe('CANCEL');
  });
  it('enforces the byte limit while streaming and rejects malformed JSON without exposing provider data', async () => {
    const payloads = [
      new Response(new Uint8Array(2000001)),
      new Response(JSON.stringify('é'.repeat(1000000))),
      new Response('small', { headers: { 'content-length': '2000001' } }),
      new Response('{"private-provider-data":'),
      new Response(new Uint8Array([255]))
    ];
    for (const payload of payloads) {
      const mock = jest.fn().mockResolvedValue(payload);
      const provider = new OpenSeaMarketplaceProvider({
        apiKey: 'test-placeholder',
        fetch: mock
      });
      await expect(
        provider.discoverOrders(intent.asset, 'LISTING')
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The marketplace provider could not complete the request.'
      });
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][1]).toMatchObject({
        redirect: 'error',
        method: 'GET'
      });
      expect(mock.mock.calls[0][1].signal.aborted).toBe(true);
    }
  });
  it('stops reading an oversized chunked response before buffering its remaining bytes', async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          if (reads === 1)
            controller.enqueue(
              new TextEncoder().encode('{"padding":"' + 'x'.repeat(1000000))
            );
          else if (reads === 2)
            controller.enqueue(new TextEncoder().encode('x'.repeat(1000000)));
          else {
            controller.enqueue(new TextEncoder().encode('"}'));
            controller.close();
          }
        }
      },
      { highWaterMark: 0 }
    );
    const mock = jest.fn().mockResolvedValue(new Response(body));
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    await expect(
      provider.discoverOrders(intent.asset, 'LISTING')
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(reads).toBe(2);
  });
  it.each(['headers', 'body'] as const)(
    'aborts a stalled %s phase after the same eight-second deadline without retry',
    async (phase) => {
      jest.useFakeTimers();
      try {
        const mock = jest
          .fn()
          .mockImplementation((_url, options: RequestInit) => {
            if (phase === 'headers')
              return new Promise((_resolve, reject) => {
                options.signal!.addEventListener(
                  'abort',
                  () => reject(new Error('private transport details')),
                  { once: true }
                );
              });
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{'));
                    options.signal!.addEventListener(
                      'abort',
                      () =>
                        controller.error(new Error('private stream details')),
                      { once: true }
                    );
                  }
                })
              )
            );
          });
        const provider = new OpenSeaMarketplaceProvider({
          apiKey: 'test-placeholder',
          fetch: mock
        });
        const result = expect(
          provider.discoverOrders(intent.asset, 'LISTING')
        ).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The marketplace provider could not complete the request.'
        });
        await jest.advanceTimersByTimeAsync(OPENSEA_REQUEST_TIMEOUT_MS);
        await result;
        expect(mock).toHaveBeenCalledTimes(1);
        expect(mock.mock.calls[0][1].signal.aborted).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    }
  );
  it('reuses an already fetched exact order while still checking identity and current counter', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const identity = {
      protocolAddress: MARKET_SEAPORT,
      orderHash: order.orderHash
    };
    const known = {
      identity,
      components: order.components,
      signature: '0x1234'
    };
    const buyIntent = {
      ...intent,
      kind: 'BUY' as const,
      wallet: buyer,
      recipient: gift,
      order: identity
    };
    const mock = jest.fn().mockResolvedValue(
      response({
        fulfillment_data: {
          transaction: {
            function: 'fulfillBasicOrder_efficient_6GL6yc(tuple)',
            chain: 1,
            to: MARKET_SEAPORT,
            value: '200',
            input_data: { parameters: { signature: '0x1234' } }
          }
        }
      })
    );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    await expect(
      provider.prepareFulfillment(buyIntent, '0', known)
    ).resolves.toMatchObject({ purpose: 'FULFILL', value: '200' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toContain('/fulfillment_data');
    mock.mockClear();
    await expect(
      provider.prepareFulfillment(buyIntent, '1', known)
    ).rejects.toThrow(/counter/);
    await expect(
      provider.prepareFulfillment(buyIntent, '0', {
        ...known,
        identity: { ...identity, orderHash: '0x' + '9'.repeat(64) }
      })
    ).rejects.toThrow(/target/);
    expect(mock).not.toHaveBeenCalled();
  });
  it('advertises a unit price only when the exact signed order supports an integral single-unit fill', () => {
    const describe = (i: MarketTradeIntent, orderType: number) => {
      const components = buildMarketOrder(i, '0', '1').order.components;
      components.orderType = orderType;
      const order = validateMarketOrder(i, components);
      return describeMarketOrder(
        {
          identity: {
            protocolAddress: MARKET_SEAPORT,
            orderHash: order.orderHash
          },
          components,
          signature: '0x'
        },
        i.asset,
        i.kind === 'LIST' ? 'LISTING' : 'OFFER'
      );
    };
    expect(describe(intent, 0).unitTotalWei).toBeUndefined();
    expect(describe(intent, 1).unitTotalWei).toBe('100');
    expect(
      describe(
        {
          ...intent,
          minNetWei: '197',
          fees: [{ recipient: gift, amountWei: '3' }]
        },
        1
      ).unitTotalWei
    ).toBeUndefined();
    expect(
      describe({ ...intent, kind: 'OFFER', currency: MARKET_WETH }, 3)
        .unitTotalWei
    ).toBe('100');
    expect(
      describe(
        {
          ...intent,
          quantity: '1',
          asset: {
            contract: '0x0c58ef43ff3032005e472cb5709f8908acb00205',
            standard: 'ERC721',
            tokenId: '1'
          }
        },
        0
      ).unitTotalWei
    ).toBe('200');
  });
  it('normalizes the advanced uint count without weakening the exact order hash', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const { counter: _counter, ...parameters } = order.components;
    const mock = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          order: {
            chain: 'ethereum',
            protocol_address: MARKET_SEAPORT,
            order_hash: order.orderHash,
            protocol_data: { parameters: order.components }
          }
        })
      )
      .mockResolvedValueOnce(
        response({
          fulfillment_data: {
            transaction: {
              function: 'fulfillAdvancedOrder(tuple)',
              chain: 1,
              to: MARKET_SEAPORT,
              value: '200',
              input_data: {
                advancedOrder: {
                  parameters: {
                    ...parameters,
                    totalOriginalConsiderationItems: '2'
                  },
                  numerator: '1',
                  denominator: '1',
                  signature: '0x1234',
                  extraData: '0x'
                },
                criteriaResolvers: [],
                fulfillerConduitKey: MARKET_OPENSEA_CONDUIT_KEY,
                recipient: gift
              }
            }
          }
        })
      );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    await expect(
      provider.prepareFulfillment(
        {
          ...intent,
          kind: 'BUY',
          wallet: buyer,
          recipient: gift,
          order: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash }
        },
        '0'
      )
    ).resolves.toMatchObject({ value: '200', purpose: 'FULFILL' });
  });
  it('returns provider coverage and pagination while preserving distinct orders for one token', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const publicOrder = {
      chain: 'ethereum',
      protocol_address: MARKET_SEAPORT,
      order_hash: order.orderHash,
      protocol_data: { parameters: order.components },
      remaining_quantity: 2
    };
    const mock = jest
      .fn()
      .mockResolvedValueOnce(response({ collection: 'thememes6529' }))
      .mockResolvedValueOnce(
        response({
          listings: [publicOrder, publicOrder],
          next: 'next/opaque?cursor'
        })
      );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    const page = await provider.discoverCollectionListings(
      intent.asset.contract,
      2,
      'prior?cursor'
    );
    expect(page.listings).toHaveLength(2);
    expect(page.coverage).toMatchObject({
      receivedCount: 2,
      acceptedCount: 2,
      hasMore: true,
      exhaustive: false
    });
    expect(mock.mock.calls[1][0]).toContain('next=prior%3Fcursor');
  });
  it('preserves the standard offer typed data and rejects unreviewed fee changes', async () => {
    const baseIntent = {
      ...intent,
      kind: 'OFFER' as const,
      currency: MARKET_WETH
    };
    const base = buildMarketOrder(baseIntent, '0', '1').order;
    const mock = jest.fn().mockImplementation(() =>
      response({
        steps: [
          {
            createOfferAction: {
              signatureRequest: {
                chainIdentifier: { chainArch: 'CHAIN_ARCH_EVM', chainId: 1 },
                message: JSON.stringify(base.typedData)
              }
            }
          }
        ]
      })
    );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    const prepared = await provider.prepareOrder(baseIntent);
    expect(prepared.order).toEqual(base);
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.use_creator_fee).toBe(false);
    const requested = {
      ...baseIntent,
      minNetWei: '197',
      fees: [...intent.fees, { recipient: maker, amountWei: '1' }]
    };
    await expect(provider.prepareOrder(requested)).rejects.toThrow();
    await expect(
      provider.prepareOrder({ ...baseIntent, recipient: buyer })
    ).rejects.toThrow(/recipient/);
  });
  it.each(['LIST', 'OFFER'] as const)(
    'publishes only the exact maker-authorized canonical %s order',
    async (kind) => {
      const wallet = Wallet.createRandom();
      const publishIntent = {
        ...intent,
        kind,
        wallet: wallet.address,
        recipient: wallet.address,
        currency: kind === 'OFFER' ? MARKET_WETH : MARKET_ZERO_ADDRESS
      };
      const order = buildMarketOrder(publishIntent, '0', '1').order;
      const signature = await wallet.signTypedData(
        order.typedData.domain,
        order.typedData.types,
        order.components
      );
      const mock = jest
        .fn()
        .mockResolvedValue(response({ order_hash: order.orderHash }));
      const provider = new OpenSeaMarketplaceProvider({
        apiKey: 'test-placeholder',
        fetch: mock
      });
      await expect(
        provider.publishOrder(publishIntent, order, signature)
      ).resolves.toEqual({ orderHash: order.orderHash });
      expect(mock.mock.calls[0][0]).toBe(
        `https://api.opensea.io/api/v2/orders/ethereum/seaport/${kind === 'LIST' ? 'listings' : 'offers'}`
      );
      expect(mock.mock.calls[0][1].method).toBe('POST');
      expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
        parameters: {
          ...order.components,
          totalOriginalConsiderationItems: order.components.consideration.length
        },
        protocol_address: MARKET_SEAPORT,
        signature
      });
      mock.mockResolvedValue(
        response({
          order_hash: '0x' + order.orderHash.slice(2).toUpperCase()
        })
      );
      await expect(
        provider.publishOrder(publishIntent, order, signature)
      ).resolves.toEqual({ orderHash: order.orderHash });
      mock.mockClear();
      const stranger = Wallet.createRandom();
      const wrongSignature = await stranger.signTypedData(
        order.typedData.domain,
        order.typedData.types,
        order.components
      );
      await expect(
        provider.publishOrder(publishIntent, order, wrongSignature)
      ).rejects.toThrow(/signature/);
      expect(mock).not.toHaveBeenCalled();
      mock.mockResolvedValue(response({ order_hash: '0x' + '9'.repeat(64) }));
      await expect(
        provider.publishOrder(publishIntent, order, signature)
      ).rejects.toThrow(/could not be confirmed/);
      expect(mock).toHaveBeenCalledTimes(1);
      mock.mockResolvedValue(response({ order_hash: 123 }));
      await expect(
        provider.publishOrder(publishIntent, order, signature)
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    }
  );
  it('treats a best-listing 404 as empty while authentication errors remain unavailable', async () => {
    const mock = jest
      .fn()
      .mockResolvedValueOnce(response({ collection: 'thememes6529' }))
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    await expect(
      provider.discoverOrders(intent.asset, 'LISTING')
    ).resolves.toEqual([]);
    mock
      .mockResolvedValueOnce(response({ collection: 'thememes6529' }))
      .mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(
      provider.discoverOrders(intent.asset, 'LISTING')
    ).rejects.toThrow(/provider/);
  });
  it('uses explicit quantities, fees and expiry and extracts only canonical typed data', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const mock = jest.fn().mockResolvedValue(
      response({
        steps: [
          { nftApprovalAction: { data: '0xmalicious' } },
          {
            createListingsAction: {
              signatureRequest: {
                chainIdentifier: { chainArch: 'CHAIN_ARCH_EVM', chainId: 1 },
                message: JSON.stringify(order.typedData)
              }
            }
          }
        ]
      })
    );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    expect((await provider.prepareOrder(intent)).order.orderHash).toBe(
      order.orderHash
    );
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.items[0]).toMatchObject({
      quantity: '2',
      start_time: '2023-11-14T22:13:20.000Z',
      end_time: '2030-03-17T17:46:40.000Z'
    });
    expect(body.use_creator_fee).toBe(false);
    expect(body.items[0].price.amount).toBe('0.0000000000000001');
  });
  it('rebuilds basic listings as advanced gift transactions and passes explicit fill units', async () => {
    const order = buildMarketOrder(intent, '0', '1').order;
    const mock = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          order: {
            chain: 'ethereum',
            protocol_address: MARKET_SEAPORT,
            order_hash: order.orderHash,
            protocol_data: { parameters: order.components }
          }
        })
      )
      .mockResolvedValueOnce(
        response({
          fulfillment_data: {
            transaction: {
              function: 'fulfillBasicOrder_efficient_6GL6yc(tuple)',
              chain: 1,
              to: MARKET_SEAPORT,
              value: '200',
              input_data: { parameters: { signature: '0x1234' } }
            }
          }
        })
      );
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'test-placeholder',
      fetch: mock
    });
    const tx = await provider.prepareFulfillment(
      {
        ...intent,
        kind: 'BUY',
        wallet: buyer,
        recipient: gift,
        order: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash }
      },
      '0'
    );
    const body = JSON.parse(mock.mock.calls[1][1].body);
    expect(body).toMatchObject({
      units_to_fill: '2',
      recipient: gift,
      include_optional_creator_fees: false
    });
    expect(
      MARKET_SEAPORT_INTERFACE.decodeFunctionData(
        'fulfillAdvancedOrder',
        tx.data
      ).recipient.toLowerCase()
    ).toBe(gift);
  });
  it('does not expose transport secrets or retry an uncertain publication', async () => {
    const mock = jest
      .fn()
      .mockRejectedValue(new Error('x-api-key secret and bearer signature'));
    const provider = new OpenSeaMarketplaceProvider({
      apiKey: 'never-print',
      fetch: mock
    });
    await expect(provider.getFeePolicy(intent.asset)).rejects.toThrow(
      'The marketplace provider could not complete the request.'
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('calculates each fee with integers and includes optional fees only when reviewed', () => {
    const policy = {
      version: 'v',
      fees: [
        { recipient: maker, basisPoints: 100, required: true },
        { recipient: gift, basisPoints: 690, required: false }
      ]
    };
    expect(marketFeesForTotal(policy, '101', false)).toEqual([
      { recipient: maker, amountWei: '1' }
    ]);
    expect(marketFeesForTotal(policy, '10000', true)).toEqual([
      { recipient: maker, amountWei: '100' },
      { recipient: gift, amountWei: '690' }
    ]);
  });
});
