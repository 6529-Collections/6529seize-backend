import { TypedDataEncoder } from 'ethers';
import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ApiCompliantException } from '@/exceptions';
import { CollectingAsset } from '@/collecting/collecting.types';
import {
  CollectingWorkBudget,
  CollectingWorkTimeout
} from '@/collecting/collecting-work-budget';
import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { marketChain } from '@/marketplace/market-chain';
import { marketCatalogAsset } from '@/marketplace/market-preparation';
import {
  MarketProviderOrder,
  MarketTradeIntent,
  MarketValidationError
} from '@/marketplace/provider.types';
import * as providerModule from '@/marketplace/provider.opensea';
import { buildMarketOrder } from '@/marketplace/seaport.builder';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import * as dtoModule from './marketplace.dto';
import { executeMarketRequest } from './marketplace.http';
import { marketplaceProvider } from './marketplace.service';
import {
  MarketOrderResolutionRequest,
  resolveMarketOrder
} from './marketplace-order-resolution';

jest.mock('@/marketplace/market-preparation', () => ({
  marketCatalogAsset: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('./marketplace.service', () => ({ marketplaceProvider: jest.fn() }));
jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));

const maker = '0x1111111111111111111111111111111111111111';
const feeRecipient = '0x2222222222222222222222222222222222222222';
const nftRecipient = '0x3333333333333333333333333333333333333333';
const now = Math.floor(Date.now() / 1000);

function updateHash(order: MarketProviderOrder): void {
  order.identity.orderHash = TypedDataEncoder.hashStruct(
    'OrderComponents',
    SEAPORT_ORDER_TYPES,
    order.components
  );
}

function setup(
  options: {
    side?: 'LISTING' | 'OFFER';
    quantity?: string;
    total?: string;
    fee?: string;
    partial?: boolean;
    erc721?: boolean;
  } = {}
) {
  const side = options.side ?? 'LISTING';
  const quantity = options.quantity ?? (options.erc721 ? '1' : '12');
  const total = options.total ?? (BigInt(quantity) * BigInt(100)).toString();
  const fee = options.fee ?? (BigInt(quantity) * BigInt(2)).toString();
  const asset: CollectingAsset = {
    asset_key: `1:${options.erc721 ? GRADIENT_CONTRACT : MEMES_CONTRACT}:56`,
    chain_id: 1,
    contract: options.erc721 ? GRADIENT_CONTRACT : MEMES_CONTRACT,
    token_id: '56',
    family: options.erc721 ? 'gradients' : 'memes',
    name: 'Resolver test artwork',
    image_url: null,
    artist_ids: [],
    season: null,
    traits: [],
    hodl_rate: null,
    tdh_eligible: true
  };
  const intent: MarketTradeIntent = {
    kind: side === 'LISTING' ? 'LIST' : 'OFFER',
    chainId: 1,
    wallet: maker,
    recipient: maker,
    asset: {
      contract: asset.contract,
      tokenId: asset.token_id,
      standard: options.erc721 ? 'ERC721' : 'ERC1155'
    },
    quantity,
    currency: side === 'LISTING' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
    maxTotalWei: total,
    minNetWei: (BigInt(total) - BigInt(fee)).toString(),
    fees: [{ recipient: feeRecipient, amountWei: fee }],
    includeOptionalCreatorFees: false,
    startTime: String(now - 60),
    endTime: String(now + 3600)
  };
  const built = buildMarketOrder(intent, '7', '23');
  const selected: MarketProviderOrder = {
    identity: {
      protocolAddress: MARKET_SEAPORT,
      orderHash: built.order.orderHash
    },
    components: built.order.components,
    signature: '0x1234'
  };
  if (options.partial !== false && !options.erc721) {
    selected.components.orderType += 1;
  }
  if (side === 'OFFER') {
    selected.components.consideration[0].recipient = nftRecipient;
  }
  updateHash(selected);
  const input: MarketOrderResolutionRequest = {
    asset_key: asset.asset_key,
    protocol_address: MARKET_SEAPORT,
    order_hash: selected.identity.orderHash,
    side
  };
  const provider = {
    getOrder: jest.fn().mockResolvedValue(selected),
    discoverOrders: jest.fn(),
    prepareFulfillment: jest.fn(),
    publishOrder: jest.fn()
  };
  const chain = {
    snapshot: jest.fn().mockResolvedValue({
      block_number: 200,
      block_hash: `0x${'ab'.repeat(32)}`,
      block_timestamp: now
    }),
    orderStatus: jest.fn().mockResolvedValue({
      cancelled: false,
      filled: BigInt(0),
      size: BigInt(0)
    }),
    counter: jest.fn().mockResolvedValue('7')
  };
  jest.mocked(marketCatalogAsset).mockResolvedValue(asset);
  jest
    .mocked(marketplaceProvider)
    .mockReturnValue(
      provider as unknown as ReturnType<typeof marketplaceProvider>
    );
  jest
    .mocked(marketChain)
    .mockReturnValue(chain as unknown as ReturnType<typeof marketChain>);
  const rehash = () => {
    updateHash(selected);
    input.order_hash = selected.identity.orderHash;
  };
  return { input, selected, asset, provider, chain, rehash };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('exact public marketplace order resolution', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it.each(['LISTING', 'OFFER'] as const)(
    'resolves the selected %s independently of best-order discovery without creating a trade',
    async (side) => {
      const s = setup({ side });
      const result = await resolveMarketOrder(s.input);
      expect(s.provider.getOrder).toHaveBeenCalledWith(s.selected.identity);
      expect(s.provider.discoverOrders).not.toHaveBeenCalled();
      expect(s.provider.prepareFulfillment).not.toHaveBeenCalled();
      expect(s.provider.publishOrder).not.toHaveBeenCalled();
      expect(s.chain.orderStatus).toHaveBeenCalledWith(s.input.order_hash);
      expect(s.chain.counter).toHaveBeenCalledWith(maker);
      expect(result).toMatchObject({
        identity: {
          protocol_address: MARKET_SEAPORT,
          order_hash: s.input.order_hash
        },
        asset_key: s.asset.asset_key,
        side,
        maker,
        recipient: side === 'LISTING' ? maker : nftRecipient,
        currency: side === 'LISTING' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
        quantity: '12',
        available_quantity: '12',
        purchase_quantity: '1',
        quantity_step: '1',
        total_wei: '1200',
        net_wei: '1176',
        fees: [{ recipient: feeRecipient, amount_wei: '24' }]
      });
      expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toEqual(
        [
          'identity',
          'asset_key',
          'maker',
          'recipient',
          'side',
          'quantity',
          'purchase_quantity',
          'quantity_step',
          'available_quantity',
          'currency',
          'total_wei',
          'net_wei',
          'fees',
          'start_time',
          'end_time'
        ].sort((a, b) => a.localeCompare(b))
      );
      expect(JSON.stringify(result)).not.toContain(s.selected.signature);
    }
  );

  it('uses the real provider parser for the exact hash response', async () => {
    const s = setup({ erc721: true });
    const fetcher = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          order: {
            chain: 'ethereum',
            protocol_address: MARKET_SEAPORT,
            order_hash: s.input.order_hash,
            protocol_data: {
              parameters: s.selected.components,
              signature: s.selected.signature
            }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    jest.mocked(marketplaceProvider).mockReturnValue(
      new providerModule.OpenSeaMarketplaceProvider({
        apiKey: 'synthetic-placeholder',
        fetch: fetcher
      })
    );
    const result = await resolveMarketOrder(s.input);
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.opensea.io/api/v2/orders/chain/ethereum/protocol/${MARKET_SEAPORT}/${s.input.order_hash}`,
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
    expect(result).toMatchObject({
      quantity: '1',
      quantity_step: '1',
      total_wei: '100'
    });
  });

  it.each([404, 401, 403, 429, 500, 503])(
    'maps upstream HTTP %i through the public HTTP boundary without exposing provider data',
    async (upstreamStatus) => {
      const s = setup();
      const privateBody = 'synthetic-private-provider-body-and-signature';
      const fetcher = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: privateBody }), {
          status: upstreamStatus,
          headers: { 'content-type': 'application/json' }
        })
      );
      jest.mocked(marketplaceProvider).mockReturnValue(
        new providerModule.OpenSeaMarketplaceProvider({
          apiKey: 'synthetic-placeholder',
          fetch: fetcher
        })
      );
      jest
        .mocked(getAuthenticationContext)
        .mockResolvedValue(AuthenticationContext.notAuthenticated());
      const dto = jest.spyOn(dtoModule, 'discoveredOrderDto');
      const req = {
        params: { order_hash: s.input.order_hash },
        query: {
          asset_key: s.input.asset_key,
          protocol_address: s.input.protocol_address,
          side: s.input.side
        },
        body: undefined,
        get: jest.fn(),
        res: { set: jest.fn() }
      };
      const error: unknown = await executeMarketRequest(req, () =>
        resolveMarketOrder(s.input)
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ApiCompliantException);
      if (!(error instanceof ApiCompliantException)) {
        throw new Error('Expected a sanitized HTTP error.');
      }
      expect(error.getStatusCode()).toBe(upstreamStatus === 404 ? 409 : 503);
      expect(error.code).toBe(
        upstreamStatus === 404 ? 'ORDER_MISMATCH' : 'PROVIDER_UNAVAILABLE'
      );
      expect(error.message).toBe(
        upstreamStatus === 404
          ? 'This order is no longer available.'
          : 'The marketplace provider could not complete the request.'
      );
      expect(error.message).not.toContain(privateBody);
      expect(JSON.stringify(error)).not.toContain(privateBody);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(getAuthenticationContext).toHaveBeenCalledWith(req);
      expect(req.res.set).toHaveBeenCalledWith({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      expect(marketChain).not.toHaveBeenCalled();
      expect(dto).not.toHaveBeenCalled();
    }
  );

  it.each([
    { order_hash: 'not-a-hash' },
    { protocol_address: MARKET_ZERO_ADDRESS },
    { protocol_address: 'not-an-address' },
    { side: 'BID' },
    { unexpected: 'field' }
  ])(
    'rejects malformed/unsupported identity input before external reads: %j',
    async (patch) => {
      const s = setup();
      await expect(
        resolveMarketOrder({
          ...s.input,
          ...patch
        } as MarketOrderResolutionRequest)
      ).rejects.toThrow();
      expect(marketCatalogAsset).not.toHaveBeenCalled();
      expect(s.provider.getOrder).not.toHaveBeenCalled();
      expect(marketChain).not.toHaveBeenCalled();
    }
  );

  it('rejects an artwork absent from the canonical catalog before provider access', async () => {
    const s = setup();
    jest
      .mocked(marketCatalogAsset)
      .mockRejectedValue(
        new MarketValidationError('INVALID_INTENT', 'Unsupported artwork.')
      );
    await expect(resolveMarketOrder(s.input)).rejects.toMatchObject({
      code: 'INVALID_INTENT'
    });
    expect(s.provider.getOrder).not.toHaveBeenCalled();
  });

  it.each([
    'hash',
    'protocol',
    'token',
    'contract',
    'side',
    'signed economics'
  ] as const)(
    'rejects an exact-order %s substitution before chain reads',
    async (field) => {
      const s = setup();
      if (field === 'hash')
        s.selected.identity.orderHash = `0x${'44'.repeat(32)}`;
      if (field === 'protocol')
        s.selected.identity.protocolAddress = MARKET_ZERO_ADDRESS;
      if (field === 'token') {
        s.selected.components.offer[0].identifierOrCriteria = '57';
        s.rehash();
      }
      if (field === 'contract') {
        s.selected.components.offer[0].token = GRADIENT_CONTRACT;
        s.rehash();
      }
      if (field === 'side') s.input.side = 'OFFER';
      if (field === 'signed economics') {
        s.selected.components.consideration[0].startAmount = '999';
        s.selected.components.consideration[0].endAmount = '999';
      }
      await expect(resolveMarketOrder(s.input)).rejects.toThrow();
      expect(marketChain).not.toHaveBeenCalled();
    }
  );

  it.each(['criteria', 'non-WETH offer', 'dynamic price'] as const)(
    'does not advertise unsupported %s as a resolvable trade',
    async (shape) => {
      const s = setup({
        side: shape === 'non-WETH offer' ? 'OFFER' : 'LISTING'
      });
      if (shape === 'criteria') s.selected.components.offer[0].itemType = 5;
      if (shape === 'non-WETH offer')
        s.selected.components.offer[0].token = feeRecipient;
      if (shape === 'dynamic price')
        s.selected.components.consideration[0].endAmount = '999';
      s.rehash();
      await expect(resolveMarketOrder(s.input)).rejects.toThrow();
      expect(marketChain).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: 'cancelled', cancelled: true, filled: '0', size: '0' },
    { name: 'fully filled', cancelled: false, filled: '6', size: '6' },
    { name: 'overfilled', cancelled: false, filled: '7', size: '6' },
    { name: 'zero size with a fill', cancelled: false, filled: '1', size: '0' },
    { name: 'negative fill', cancelled: false, filled: '-1', size: '6' },
    { name: 'negative size', cancelled: false, filled: '0', size: '-1' },
    {
      name: 'fractional NFT remainder',
      cancelled: false,
      filled: '1',
      size: '5'
    }
  ])('rejects $name status', async ({ cancelled, filled, size }) => {
    const s = setup();
    s.chain.orderStatus.mockResolvedValue({
      cancelled,
      filled: BigInt(filled),
      size: BigInt(size)
    });
    await expect(resolveMarketOrder(s.input)).rejects.toMatchObject({
      code: 'ORDER_MISMATCH'
    });
  });

  it.each(['LISTING', 'OFFER'] as const)(
    'scales the complete remaining %s and each fee using an unreduced fill fraction',
    async (side) => {
      const s = setup({ side });
      s.chain.orderStatus.mockResolvedValue({
        cancelled: false,
        filled: BigInt(2),
        size: BigInt(6)
      });
      expect(await resolveMarketOrder(s.input)).toMatchObject({
        quantity: '8',
        available_quantity: '8',
        purchase_quantity: '1',
        quantity_step: '1',
        total_wei: '800',
        net_wei: '784',
        fees: [{ recipient: feeRecipient, amount_wei: '16' }]
      });
    }
  );

  it('keeps quantities and wei exact above the safe integer range', async () => {
    const s = setup({ quantity: '54043195528445958' });
    s.chain.orderStatus.mockResolvedValue({
      cancelled: false,
      filled: BigInt(2),
      size: BigInt(6)
    });
    expect(await resolveMarketOrder(s.input)).toMatchObject({
      quantity: '36028797018963972',
      available_quantity: '36028797018963972',
      total_wei: '3602879701896397200',
      net_wei: '3530822107858469256',
      fees: [{ recipient: feeRecipient, amount_wei: '72057594037927944' }]
    });
  });

  it.each([
    { partial: false, fee: '2' },
    { partial: true, fee: '1' }
  ])(
    'keeps an indivisible lot explicit (partial=$partial, fee=$fee)',
    async (options) => {
      const s = setup({ quantity: '2', total: '200', ...options });
      expect(await resolveMarketOrder(s.input)).toMatchObject({
        quantity: '2',
        purchase_quantity: '2',
        quantity_step: '2',
        total_wei: '200',
        fees: [{ recipient: feeRecipient, amount_wei: options.fee }]
      });
      s.chain.orderStatus.mockResolvedValue({
        cancelled: false,
        filled: BigInt(1),
        size: BigInt(2)
      });
      await expect(resolveMarketOrder(s.input)).rejects.toMatchObject({
        code: expect.stringMatching(/ORDER_MISMATCH|AMOUNT_MISMATCH/)
      });
    }
  );

  it.each([
    'changed counter',
    'future start',
    'expired',
    'expiry boundary'
  ] as const)('rejects an order with %s', async (reason) => {
    const s = setup();
    if (reason === 'changed counter') s.chain.counter.mockResolvedValue('8');
    if (reason === 'future start')
      s.selected.components.startTime = String(now + 1);
    if (reason === 'expired') s.selected.components.endTime = String(now - 1);
    if (reason === 'expiry boundary')
      s.selected.components.endTime = String(now);
    s.rehash();
    await expect(resolveMarketOrder(s.input)).rejects.toMatchObject({
      code: 'ORDER_MISMATCH'
    });
  });

  it('propagates a rejected chain snapshot without producing a DTO', async () => {
    const s = setup();
    const dto = jest.spyOn(dtoModule, 'discoveredOrderDto');
    s.chain.snapshot.mockRejectedValue(
      new MarketValidationError('UNSUPPORTED_PROTOCOL', 'Incorrect chain.')
    );
    await expect(resolveMarketOrder(s.input)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL'
    });
    expect(dto).not.toHaveBeenCalled();
  });

  it.each(['catalog', 'provider', 'chain'] as const)(
    'does not resume downstream work after a late %s read',
    async (stage) => {
      const s = setup();
      const started = deferred<void>();
      const release = deferred<void>();
      const descriptor = jest.spyOn(providerModule, 'describeMarketOrder');
      const dto = jest.spyOn(dtoModule, 'discoveredOrderDto');
      let elapsed = 0;
      const lateRead = async <T>(value: T): Promise<T> => {
        started.resolve();
        await release.promise;
        return value;
      };
      if (stage === 'catalog')
        jest
          .mocked(marketCatalogAsset)
          .mockImplementationOnce(() => lateRead(s.asset));
      if (stage === 'provider')
        s.provider.getOrder.mockImplementationOnce(() => lateRead(s.selected));
      if (stage === 'chain')
        s.chain.counter.mockImplementationOnce(() => lateRead('7'));
      const result = resolveMarketOrder(
        s.input,
        new CollectingWorkBudget(20000, () => elapsed)
      );
      const failure = expect(result).rejects.toBeInstanceOf(
        CollectingWorkTimeout
      );
      await started.promise;
      elapsed = 20001;
      release.resolve();
      await failure;
      expect(dto).not.toHaveBeenCalled();
      if (stage === 'catalog')
        expect(s.provider.getOrder).not.toHaveBeenCalled();
      if (stage !== 'chain') {
        expect(descriptor).not.toHaveBeenCalled();
        expect(marketChain).not.toHaveBeenCalled();
      } else expect(descriptor).toHaveBeenCalledTimes(1);
    }
  );

  it('starts no reads if the shared budget is already exhausted', async () => {
    const s = setup();
    await expect(
      resolveMarketOrder(s.input, new CollectingWorkBudget(0))
    ).rejects.toBeInstanceOf(CollectingWorkTimeout);
    expect(marketCatalogAsset).not.toHaveBeenCalled();
    expect(s.provider.getOrder).not.toHaveBeenCalled();
  });
});
