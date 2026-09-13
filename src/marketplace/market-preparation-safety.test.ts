import {
  MarketPreparation,
  marketPrepareSchema,
  MarketPrepareRequest
} from '@/marketplace/market-preparation';
import type { MarketChain } from '@/marketplace/market-chain';
import type { OpenSeaMarketplaceProvider } from '@/marketplace/provider.opensea';
import { collectingService } from '@/collecting/collecting.service';
import { collectingTradeAssetsDb } from '@/collecting/collecting-trade-assets';
import { MEMELAB_CONTRACT } from '@/constants';
import {
  buildMarketOrder,
  buildMarketFulfillment
} from '@/marketplace/seaport.builder';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { MarketTradeIntent } from '@/marketplace/provider.types';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const contract = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const assetKey = `1:${contract}:56`;
const intent: MarketTradeIntent = {
  kind: 'LIST',
  chainId: 1,
  wallet,
  recipient: wallet,
  asset: { contract, tokenId: '56', standard: 'ERC1155' },
  quantity: '2',
  currency: MARKET_ZERO_ADDRESS,
  maxTotalWei: '200',
  minNetWei: '200',
  fees: [],
  includeOptionalCreatorFees: false,
  startTime: '1800000000',
  endTime: '1800001000'
};
const request: MarketPrepareRequest = {
  profile_id: 'profile',
  kind: 'CANCEL',
  wallet,
  recipient: wallet,
  asset_key: assetKey,
  quantity: '2',
  currency: MARKET_ZERO_ADDRESS,
  amount_wei: '200',
  acknowledge_external_recipient: false
};
function setup() {
  const provider = {
    getOrder: jest.fn().mockRejectedValue(new Error('provider unavailable')),
    getFeePolicy: jest.fn().mockResolvedValue({ version: 'fees', fees: [] }),
    prepareFulfillment: jest.fn(),
    prepareOrder: jest
      .fn()
      .mockImplementation(async (i) => buildMarketOrder(i, '0', '1'))
  };
  const chain = {
    rpc: { getCode: jest.fn().mockResolvedValue('0x') },
    snapshot: jest.fn().mockResolvedValue({
      block_number: 100,
      block_hash: '0x' + '1'.repeat(64),
      block_timestamp: 1800000000
    }),
    simulate: jest.fn().mockResolvedValue({
      gas_limit: '100',
      max_fee_per_gas: '1',
      gas_reserve_wei: '100'
    }),
    counter: jest.fn().mockResolvedValue('0'),
    currencyBalance: jest.fn().mockResolvedValue('1000'),
    orderStatus: jest.fn().mockResolvedValue({
      cancelled: false,
      size: BigInt(0),
      filled: BigInt(0)
    }),
    approvals: jest.fn().mockResolvedValue([])
  };
  return {
    provider,
    chain,
    preparation: new MarketPreparation(
      provider as unknown as OpenSeaMarketplaceProvider,
      chain as unknown as MarketChain
    )
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (collectingService.getCatalog as jest.Mock).mockRejectedValue(
    new Error('catalog unavailable')
  );
});

describe('trade request expiry and exact-order contract', () => {
  describe('Meme Lab card actions', () => {
    afterEach(() => jest.restoreAllMocks());
    function labSetup() {
      const s = setup();
      (collectingService.getCatalog as jest.Mock).mockResolvedValue({
        version: 'planner',
        assets: []
      });
      jest
        .spyOn(collectingTradeAssetsDb, 'readMemeLabAssets')
        .mockResolvedValue([
          {
            asset_key: `1:${MEMELAB_CONTRACT}:56`,
            contract: MEMELAB_CONTRACT,
            token_id: '56',
            family: 'memelab',
            chain_id: 1,
            name: 'Lab artwork',
            image_url: null,
            artist_ids: [],
            season: null,
            traits: [],
            hodl_rate: null,
            tdh_eligible: false
          }
        ]);
      return s;
    }

    it.each(['LIST', 'OFFER'] as const)(
      'prepares exact Meme Lab %s signing terms and approval scope',
      async (kind) => {
        const s = labSetup();
        const prepared = await s.preparation.prepare(
          {
            ...request,
            kind,
            asset_key: `1:${MEMELAB_CONTRACT}:56`,
            currency: kind === 'OFFER' ? MARKET_WETH : MARKET_ZERO_ADDRESS,
            expires_at: 1800001000
          },
          true
        );
        expect(prepared.intent.asset).toEqual({
          contract: MEMELAB_CONTRACT,
          tokenId: '56',
          standard: 'ERC1155'
        });
        expect(prepared.intent.quantity).toBe('2');
        expect(s.chain.approvals).toHaveBeenCalledWith(
          expect.objectContaining({ asset: prepared.intent.asset }),
          expect.any(String)
        );
        const components = prepared.signedOrder!.order.components;
        const item =
          kind === 'LIST' ? components.offer[0] : components.consideration[0];
        expect(item).toMatchObject({
          token: MEMELAB_CONTRACT,
          itemType: 3,
          identifierOrCriteria: '56',
          startAmount: '2'
        });
      }
    );

    it.each(['BUY', 'ACCEPT'] as const)(
      'binds the exact Meme Lab %s order and recipient before approval',
      async (kind) => {
        const s = labSetup();
        const otherMaker = recipient;
        const currency = kind === 'BUY' ? MARKET_ZERO_ADDRESS : MARKET_WETH;
        const orderIntent: MarketTradeIntent = {
          ...intent,
          kind: kind === 'BUY' ? 'LIST' : 'OFFER',
          wallet: otherMaker,
          recipient: otherMaker,
          currency,
          asset: {
            contract: MEMELAB_CONTRACT,
            tokenId: '56',
            standard: 'ERC1155'
          }
        };
        const built = buildMarketOrder(orderIntent, '0', '8').order;
        s.provider.getOrder.mockResolvedValue({
          identity: {
            protocolAddress: MARKET_SEAPORT,
            orderHash: built.orderHash
          },
          components: built.components
        });
        s.provider.prepareFulfillment.mockImplementation(async (fresh) =>
          buildMarketFulfillment(
            fresh,
            built,
            '0x1234',
            built.components.orderType >= 2 ? '0xabcd' : '0x'
          )
        );
        const prepared = await s.preparation.prepare(
          {
            ...request,
            kind,
            asset_key: `1:${MEMELAB_CONTRACT}:56`,
            currency,
            order: {
              protocol_address: MARKET_SEAPORT,
              order_hash: built.orderHash
            }
          },
          true
        );
        expect(prepared.intent.asset.standard).toBe('ERC1155');
        expect(prepared.reviewOrder?.orderHash).toBe(built.orderHash);
        expect(prepared.nftRecipient).toBe(
          kind === 'BUY' ? wallet : otherMaker
        );
        expect(prepared.transaction?.to).toBe(MARKET_SEAPORT);
        expect(s.chain.approvals).toHaveBeenCalledWith(
          expect.objectContaining({ asset: prepared.intent.asset })
        );
        s.provider.getOrder.mockResolvedValue({
          identity: {
            protocolAddress: MARKET_SEAPORT,
            orderHash: built.orderHash
          },
          components: { ...built.components, offerer: wallet }
        });
        await expect(
          s.preparation.prepare(
            {
              ...request,
              kind,
              asset_key: `1:${MEMELAB_CONTRACT}:56`,
              currency,
              order: {
                protocol_address: MARKET_SEAPORT,
                order_hash: built.orderHash
              }
            },
            true
          )
        ).rejects.toThrow();
        expect(s.chain.approvals).toHaveBeenCalledTimes(1);
      }
    );

    it('cancels only the signer-owned exact Meme Lab listing even if catalog/provider lookup is unavailable', async () => {
      const s = setup();
      const built = buildMarketOrder(
        {
          ...intent,
          asset: {
            contract: MEMELAB_CONTRACT,
            tokenId: '56',
            standard: 'ERC1155'
          }
        },
        '0',
        '8'
      ).order;
      const identity = {
        protocolAddress: MARKET_SEAPORT,
        orderHash: built.orderHash
      };
      const prepared = await s.preparation.prepare(
        {
          ...request,
          asset_key: `1:${MEMELAB_CONTRACT}:56`,
          order: {
            protocol_address: MARKET_SEAPORT,
            order_hash: built.orderHash
          }
        },
        true,
        { identity, components: built.components }
      );
      expect(prepared.intent.asset.contract).toBe(MEMELAB_CONTRACT);
      expect(prepared.transaction?.purpose).toBe('CANCEL');
      expect(s.provider.getOrder).not.toHaveBeenCalled();
    });
  });
  it.each(['LIST', 'OFFER'] as const)(
    'requires Unix-seconds expiry for %s',
    (kind) => {
      expect(marketPrepareSchema.safeParse({ ...request, kind }).success).toBe(
        false
      );
      expect(
        marketPrepareSchema.safeParse({
          ...request,
          kind,
          expires_at: 1800001000
        }).success
      ).toBe(true);
    }
  );

  it.each(['BUY', 'ACCEPT', 'CANCEL'] as const)(
    'requires an exact order and rejects expiry overrides for %s',
    (kind) => {
      const input = {
        ...request,
        kind,
        order: {
          protocol_address: MARKET_SEAPORT,
          order_hash: `0x${'a'.repeat(64)}`
        }
      };
      expect(marketPrepareSchema.safeParse({ ...request, kind }).success).toBe(
        false
      );
      expect(marketPrepareSchema.safeParse(input).success).toBe(true);
      expect(
        marketPrepareSchema.safeParse({ ...input, expires_at: 1800001000 })
          .success
      ).toBe(false);
    }
  );
});

it('prepares saved-order cancellation during simultaneous catalog and provider outages', async () => {
  const { provider, chain, preparation } = setup();
  const order = buildMarketOrder(intent, '0', '1').order;
  const known = {
    identity: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash },
    components: order.components
  };
  const prepared = await preparation.prepare(
    {
      ...request,
      order: { protocol_address: MARKET_SEAPORT, order_hash: order.orderHash }
    },
    true,
    known
  );
  expect(prepared.transaction).toMatchObject({
    purpose: 'CANCEL',
    to: MARKET_SEAPORT,
    value: '0'
  });
  expect(prepared.intent.maxTotalWei).toBe('0');
  expect(collectingService.getCatalog).not.toHaveBeenCalled();
  expect(provider.getOrder).not.toHaveBeenCalled();
  expect(provider.getFeePolicy).not.toHaveBeenCalled();
  expect(chain.simulate).toHaveBeenCalled();
});
it('cannot substitute another saved order identity or displayed artwork for cancellation', async () => {
  const { preparation } = setup();
  const order = buildMarketOrder(intent, '0', '1').order;
  const known = {
    identity: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash },
    components: order.components
  };
  await expect(
    preparation.prepare(
      {
        ...request,
        order: {
          protocol_address: MARKET_SEAPORT,
          order_hash: '0x' + '9'.repeat(64)
        }
      },
      true,
      known
    )
  ).rejects.toThrow(/saved cancellation target/);
  await expect(
    preparation.prepare(
      {
        ...request,
        asset_key: `1:${contract}:57`,
        order: { protocol_address: MARKET_SEAPORT, order_hash: order.orderHash }
      },
      true,
      known
    )
  ).rejects.toThrow(/artwork/);
});
it.each(['BUY', 'LIST', 'OFFER', 'ACCEPT', 'CANCEL'] as const)(
  'gates unverified smart-wallet execution for %s',
  async (kind) => {
    const { chain, preparation } = setup();
    chain.rpc.getCode.mockResolvedValue('0x6000');
    await expect(
      preparation.prepare({ ...request, kind }, true)
    ).rejects.toThrow(/smart wallet/);
    expect(collectingService.getCatalog).not.toHaveBeenCalled();
  }
);
it('allows an explicitly reviewed smart-wallet destination while the signing wallet is EOA', async () => {
  const { chain, provider, preparation } = setup();
  (collectingService.getCatalog as jest.Mock).mockResolvedValue({
    assets: [{ asset_key: assetKey, contract, token_id: '56', family: 'memes' }]
  });
  const seller = '0x3333333333333333333333333333333333333333';
  const order = buildMarketOrder(
    { ...intent, wallet: seller, recipient: seller },
    '0',
    '1'
  ).order;
  provider.getOrder.mockResolvedValue({
    identity: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash },
    components: order.components
  });
  provider.prepareFulfillment.mockImplementation(async (i) =>
    buildMarketFulfillment(i, order, '0x1234')
  );
  const prepared = await preparation.prepare(
    {
      ...request,
      kind: 'BUY',
      recipient,
      currency: MARKET_ZERO_ADDRESS,
      order: { protocol_address: MARKET_SEAPORT, order_hash: order.orderHash },
      acknowledge_external_recipient: true,
      expires_at: 1800001000
    },
    false
  );
  expect(prepared.nftRecipient).toBe(recipient);
  expect(chain.rpc.getCode).toHaveBeenCalledTimes(1);
  expect(chain.rpc.getCode).toHaveBeenCalledWith(wallet);
});
it.each(['LIST', 'OFFER'] as const)(
  'uses the explicit standard creator fee policy for %s',
  async (kind) => {
    const { provider, preparation } = setup();
    (collectingService.getCatalog as jest.Mock).mockResolvedValue({
      assets: [
        { asset_key: assetKey, contract, token_id: '56', family: 'memes' }
      ]
    });
    provider.getFeePolicy.mockResolvedValue({
      version: 'fees',
      fees: [
        { recipient, basisPoints: 100, required: true },
        {
          recipient: '0x3333333333333333333333333333333333333333',
          basisPoints: 500,
          required: false
        }
      ]
    });
    const prepared = await preparation.prepare(
      {
        ...request,
        kind,
        currency: kind === 'LIST' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
        expires_at: 1800001000
      },
      true
    );
    expect(prepared.intent.includeOptionalCreatorFees).toBe(kind === 'LIST');
    expect(prepared.intent.fees).toHaveLength(kind === 'LIST' ? 2 : 1);
    expect(prepared.intent.minNetWei).toBe(kind === 'LIST' ? '188' : '198');
    expect(prepared.signedOrder?.order.components.offerer).toBe(wallet);
  }
);
it('reports insufficient WETH before requesting unsigned offer actions', async () => {
  const { provider, chain, preparation } = setup();
  (collectingService.getCatalog as jest.Mock).mockResolvedValue({
    assets: [{ asset_key: assetKey, contract, token_id: '56', family: 'memes' }]
  });
  chain.currencyBalance.mockResolvedValue('199');
  await expect(
    preparation.prepare(
      {
        ...request,
        kind: 'OFFER',
        currency: MARKET_WETH,
        expires_at: 1800001000
      },
      true
    )
  ).rejects.toThrow(/enough WETH/);
  expect(provider.getFeePolicy).not.toHaveBeenCalled();
  expect(provider.prepareOrder).not.toHaveBeenCalled();
});

it('defers fulfillment simulation until the required WETH approval has been mined', async () => {
  const { chain, provider, preparation } = setup();
  (collectingService.getCatalog as jest.Mock).mockResolvedValue({
    assets: [{ asset_key: assetKey, contract, token_id: '56', family: 'memes' }]
  });
  const seller = '0x3333333333333333333333333333333333333333';
  const order = buildMarketOrder(
    { ...intent, wallet: seller, recipient: seller, currency: MARKET_WETH },
    '0',
    '1'
  ).order;
  provider.getOrder.mockResolvedValue({
    identity: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash },
    components: order.components
  });
  provider.prepareFulfillment.mockImplementation(async (i) =>
    buildMarketFulfillment(i, order, '0x1234')
  );
  const approval = {
    purpose: 'APPROVE_CURRENCY',
    gas: {
      gas_limit: '60000',
      max_fee_per_gas: '10',
      gas_reserve_wei: '600000'
    }
  };
  chain.approvals.mockResolvedValue([approval]);
  const buy: MarketPrepareRequest = {
    ...request,
    kind: 'BUY',
    currency: MARKET_WETH,
    order: { protocol_address: MARKET_SEAPORT, order_hash: order.orderHash },
    expires_at: 1800001000
  };
  const waiting = await preparation.prepare(buy, true);
  expect(waiting.approvalTransactions).toEqual([approval]);
  expect(waiting.gas).toBeUndefined();
  expect(chain.simulate).not.toHaveBeenCalled();
  chain.approvals.mockResolvedValue([]);
  const ready = await preparation.prepare(buy, true);
  expect(ready.approvalTransactions).toEqual([]);
  expect(chain.simulate).toHaveBeenCalledWith(ready.transaction);
  expect(ready.gas?.gas_reserve_wei).toBe('100');
});
