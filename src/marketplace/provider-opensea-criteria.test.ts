import { TypedDataEncoder } from 'ethers';
import type { MarketTradeIntent } from '@/marketplace/provider.types';
import {
  OpenSeaMarketplaceProvider,
  describeIndexedMarketOrder
} from '@/marketplace/provider.opensea';
import {
  buildMarketOrder,
  MARKET_SEAPORT_INTERFACE
} from '@/marketplace/seaport.builder';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import {
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';

const maker = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const fee = '0x3333333333333333333333333333333333333333';

function fixture() {
  const offer: MarketTradeIntent = {
    kind: 'OFFER',
    chainId: 1,
    wallet: maker,
    recipient: maker,
    asset: {
      contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
      tokenId: '56',
      standard: 'ERC1155'
    },
    quantity: '3',
    currency: MARKET_WETH,
    maxTotalWei: '300',
    minNetWei: '297',
    fees: [{ recipient: fee, amountWei: '3' }],
    includeOptionalCreatorFees: false,
    startTime: '1700000000',
    endTime: '1900000000'
  };
  const components = buildMarketOrder(offer, '4', '5').order.components;
  components.orderType = 3;
  components.consideration[0].itemType = 5;
  components.consideration[0].identifierOrCriteria = '0';
  const hash = TypedDataEncoder.hashStruct(
    'OrderComponents',
    SEAPORT_ORDER_TYPES,
    components
  );
  const order = {
    chain: 'ethereum',
    protocol_address: MARKET_SEAPORT,
    order_hash: hash,
    protocol_data: { parameters: components }
  };
  const intent: MarketTradeIntent = {
    ...offer,
    kind: 'ACCEPT',
    wallet: seller,
    recipient: seller,
    quantity: '1',
    maxTotalWei: '100',
    minNetWei: '99',
    fees: [{ recipient: fee, amountWei: '1' }],
    order: { protocolAddress: MARKET_SEAPORT, orderHash: hash }
  };
  const { counter: _counter, ...parameters } = structuredClone(components);
  const input = {
    advancedOrder: {
      parameters: {
        ...parameters,
        totalOriginalConsiderationItems: parameters.consideration.length
      },
      numerator: '1',
      denominator: '3',
      signature: '0x1234',
      extraData: '0xabcd'
    },
    criteriaResolvers: [
      {
        orderIndex: '0',
        side: 1,
        index: '0',
        identifier: '56',
        criteriaProof: [] as string[]
      }
    ],
    fulfillerConduitKey: MARKET_OPENSEA_CONDUIT_KEY,
    recipient: seller
  };
  const fulfillment = {
    fulfillment_data: {
      transaction: {
        function: 'fulfillAdvancedOrder(tuple)',
        chain: 1,
        to: MARKET_SEAPORT,
        value: '0',
        input_data: input
      }
    }
  };
  return { components, order, intent, input, fulfillment };
}

function providerFor(value: ReturnType<typeof fixture>) {
  const response = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' }
    });
  const fetch = jest
    .fn()
    .mockResolvedValueOnce(response({ order: value.order }))
    .mockResolvedValueOnce(response(value.fulfillment));
  return {
    fetch,
    provider: new OpenSeaMarketplaceProvider({
      apiKey: 'synthetic-test-only',
      fetch
    })
  };
}

describe('OpenSea criteria-offer fulfillment boundary', () => {
  it.each([false, true])(
    'binds the NFT and exact one-third fill with optional creator fees=%s',
    async (includeOptionalCreatorFees) => {
      const value = fixture();
      value.intent.includeOptionalCreatorFees = includeOptionalCreatorFees;
      const { provider, fetch } = providerFor(value);
      const tx = await provider.prepareFulfillment(value.intent, '4');
      expect(tx).toMatchObject({
        chainId: 1,
        from: seller,
        to: MARKET_SEAPORT,
        value: '0',
        purpose: 'FULFILL'
      });
      const request = JSON.parse(fetch.mock.calls[1][1].body);
      expect(request).toMatchObject({
        offer: { hash: value.order.order_hash },
        consideration: {
          asset_contract_address: value.intent.asset.contract,
          token_id: '56'
        },
        fulfiller: { address: seller },
        units_to_fill: '1',
        include_optional_creator_fees: includeOptionalCreatorFees
      });
      const decoded = MARKET_SEAPORT_INTERFACE.decodeFunctionData(
        'fulfillAdvancedOrder',
        tx.data
      );
      expect(decoded.criteriaResolvers[0].identifier.toString()).toBe('56');
      expect(decoded.criteriaResolvers[0].criteriaProof).toHaveLength(0);
      expect(
        decoded.advancedOrder.parameters.consideration[0].identifierOrCriteria.toString()
      ).toBe('0');
      expect(decoded.advancedOrder.numerator.toString()).toBe('1');
      expect(decoded.advancedOrder.denominator.toString()).toBe('3');
    }
  );

  it.each([
    'token',
    'side',
    'index',
    'order-index',
    'proof',
    'extra-resolver',
    'no-resolver',
    'root',
    'standard',
    'fee-amount',
    'fee-recipient',
    'unsigned-tip',
    'operator',
    'zone-authorization',
    'native-value',
    'chain',
    'protocol'
  ])(
    'rejects changed provider %s before returning an executable transaction',
    async (change) => {
      const value = fixture();
      const resolver = value.input.criteriaResolvers[0];
      const parameters = value.input.advancedOrder.parameters;
      if (change === 'token') resolver.identifier = '57';
      if (change === 'side') resolver.side = 0;
      if (change === 'index') resolver.index = '1';
      if (change === 'order-index') resolver.orderIndex = '1';
      if (change === 'proof') resolver.criteriaProof = [MARKET_ZERO_HASH];
      if (change === 'extra-resolver')
        value.input.criteriaResolvers.push({ ...resolver });
      if (change === 'no-resolver') value.input.criteriaResolvers = [];
      if (change === 'root')
        parameters.consideration[0].identifierOrCriteria = '56';
      if (change === 'standard') parameters.consideration[0].itemType = 4;
      if (change === 'fee-amount')
        parameters.consideration[1].startAmount =
          parameters.consideration[1].endAmount = '6';
      if (change === 'fee-recipient')
        parameters.consideration[1].recipient = seller;
      if (change === 'unsigned-tip')
        parameters.consideration.push({ ...parameters.consideration[1] });
      if (change === 'operator')
        value.input.fulfillerConduitKey = MARKET_ZERO_HASH;
      if (change === 'zone-authorization')
        value.input.advancedOrder.extraData = '0x';
      if (change === 'native-value')
        value.fulfillment.fulfillment_data.transaction.value = '1';
      if (change === 'chain')
        value.fulfillment.fulfillment_data.transaction.chain = 10;
      if (change === 'protocol')
        value.fulfillment.fulfillment_data.transaction.to = seller;
      const { provider } = providerFor(value);
      await expect(
        provider.prepareFulfillment(value.intent, '4')
      ).rejects.toThrow();
    }
  );

  it('rejects a changed maker counter before requesting provider fulfillment', async () => {
    const value = fixture();
    const { provider, fetch } = providerFor(value);
    await expect(
      provider.prepareFulfillment(value.intent, '5')
    ).rejects.toThrow(/counter/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed signed hash before requesting provider fulfillment', async () => {
    const value = fixture();
    value.order.protocol_data.parameters.salt = '9';
    const { provider, fetch } = providerFor(value);
    await expect(
      provider.prepareFulfillment(value.intent, '4')
    ).rejects.toThrow(/hash/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'does not accept provider-appended creator consideration when optional flag=%s',
    async (includeOptionalCreatorFees) => {
      const value = fixture();
      value.intent.includeOptionalCreatorFees = includeOptionalCreatorFees;
      value.input.advancedOrder.parameters.consideration.push({
        ...value.input.advancedOrder.parameters.consideration[1],
        recipient: seller
      });
      value.input.advancedOrder.parameters.totalOriginalConsiderationItems++;
      const { provider } = providerFor(value);
      await expect(
        provider.prepareFulfillment(value.intent, '4')
      ).rejects.toThrow(/signed order/);
    }
  );

  it('does not promote an unresolved collection order into an exact-token advisory reference', () => {
    const value = fixture();
    expect(() =>
      describeIndexedMarketOrder(value.order, value.intent.asset, 'OFFER', '1')
    ).toThrow();
  });
});
