import { Wallet } from 'ethers';
import { MarketTradeIntent } from '@/marketplace/provider.types';
import {
  MARKET_OPENSEA_CONDUIT,
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import {
  assertMarketEoaSignature,
  buildMarketFulfillment,
  buildMarketOrder,
  MARKET_SEAPORT_INTERFACE,
  prepareMarketCancel,
  validateMarketTypedData
} from '@/marketplace/seaport.builder';
import { validateMarketOrder } from '@/marketplace/quote-validation';

const maker = '0x1111111111111111111111111111111111111111';
const buyer = '0x2222222222222222222222222222222222222222';
const gift = '0x3333333333333333333333333333333333333333';
const fee = '0x4444444444444444444444444444444444444444';
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
  quantity: '3',
  currency: MARKET_ZERO_ADDRESS,
  maxTotalWei: '300',
  minNetWei: '297',
  fees: [{ recipient: fee, amountWei: '3' }],
  includeOptionalCreatorFees: false,
  startTime: '1700000000',
  endTime: '1900000000'
};
function prepared() {
  return buildMarketOrder(intent, '4', '5').order;
}
function buy() {
  const order = prepared();
  return {
    ...intent,
    kind: 'BUY' as const,
    wallet: buyer,
    recipient: gift,
    order: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash }
  };
}

describe('exact Seaport economic boundary', () => {
  it('hashes the signed components and builds same-transaction gift fulfillment', () => {
    const order = prepared();
    const tx = buildMarketFulfillment(buy(), order, '0x1234');
    expect(tx).toMatchObject({
      from: buyer,
      to: MARKET_SEAPORT,
      value: '300',
      purpose: 'FULFILL'
    });
    const decoded = MARKET_SEAPORT_INTERFACE.decodeFunctionData(
      'fulfillAdvancedOrder',
      tx.data
    );
    expect(decoded.recipient.toLowerCase()).toBe(gift);
    expect(
      decoded.advancedOrder.parameters.offer[0].identifierOrCriteria.toString()
    ).toBe('56');
    expect(decoded.advancedOrder.numerator.toString()).toBe('1');
    expect(decoded.advancedOrder.denominator.toString()).toBe('1');
  });
  it.each([
    'asset',
    'quantity',
    'price',
    'recipient',
    'conduit',
    'zone',
    'dynamic',
    'criteria',
    'counter'
  ])('rejects changed %s', (change) => {
    const c = structuredClone(prepared().components);
    if (change === 'asset') c.offer[0].identifierOrCriteria = '57';
    if (change === 'quantity')
      c.offer[0].startAmount = c.offer[0].endAmount = '4';
    if (change === 'price')
      c.consideration[0].startAmount = c.consideration[0].endAmount = '298';
    if (change === 'recipient') c.consideration[1].recipient = gift;
    if (change === 'conduit') c.conduitKey = '0x' + '1'.repeat(64);
    if (change === 'zone') c.zone = gift;
    if (change === 'dynamic') c.consideration[0].endAmount = '1';
    if (change === 'criteria') c.offer[0].itemType = 5;
    if (change === 'counter') c.counter = '5';
    expect(() => validateMarketOrder(buy(), c)).toThrow();
  });
  it('requires exact divisibility of every fee for a partial ERC1155 fill', () => {
    const c = prepared().components;
    c.orderType = 1;
    const partial = {
      ...buy(),
      order: undefined,
      quantity: '1',
      maxTotalWei: '100',
      minNetWei: '99',
      fees: [{ recipient: fee, amountWei: '1' }]
    };
    expect(validateMarketOrder(partial, c).totalWei).toBe('100');
    c.consideration[1].startAmount = c.consideration[1].endAmount = '4';
    expect(() => validateMarketOrder(partial, c)).toThrow(/round/);
  });
  it('does not treat a full-fill order as partially fillable', () => {
    expect(() =>
      validateMarketOrder(
        { ...buy(), order: undefined, quantity: '1' },
        prepared().components
      )
    ).toThrow(/quantity/);
  });
  it('rejects changed EIP712 domains and signed field declarations', () => {
    const typed = structuredClone(prepared().typedData);
    (typed.domain as { chainId: number }).chainId = 10;
    expect(() => validateMarketTypedData(intent, typed)).toThrow();
    const fields = structuredClone(prepared().typedData);
    fields.types.OrderComponents.push({ name: 'operator', type: 'address' });
    expect(() => validateMarketTypedData(intent, fields)).toThrow(/fields/);
  });
  it('verifies exact maker signature and cannot reuse it after changing price', async () => {
    const wallet = Wallet.createRandom();
    const order = buildMarketOrder(
      { ...intent, wallet: wallet.address, recipient: wallet.address },
      '0',
      '7'
    ).order;
    const signature = await wallet.signTypedData(
      order.typedData.domain,
      order.typedData.types,
      order.components
    );
    expect(() => assertMarketEoaSignature(order, signature)).not.toThrow();
    const changed = structuredClone(order);
    changed.components.salt = '8';
    expect(() => assertMarketEoaSignature(changed, signature)).toThrow(
      /signature/
    );
  });
  it('encodes cancellation only for the exact maker/order hash', () => {
    const order = prepared(),
      identity = {
        protocolAddress: MARKET_SEAPORT,
        orderHash: order.orderHash
      };
    expect(prepareMarketCancel(maker, identity, order.components).value).toBe(
      '0'
    );
    expect(() =>
      prepareMarketCancel(buyer, identity, order.components)
    ).toThrow(/maker/);
    expect(() =>
      prepareMarketCancel(
        maker,
        { ...identity, orderHash: '0x' + '1'.repeat(64) },
        order.components
      )
    ).toThrow(/target/);
  });
  it('limits new offers to the signer destination and rejects native ETH', () => {
    expect(() =>
      buildMarketOrder({ ...intent, kind: 'OFFER' }, '0', '1')
    ).toThrow(/WETH/);
    const offerIntent = {
      ...intent,
      kind: 'OFFER' as const,
      currency: MARKET_WETH,
      recipient: maker
    };
    const order = buildMarketOrder(offerIntent, '0', '1').order;
    expect(order.components.consideration[0].recipient).toBe(maker);
    expect(() =>
      buildMarketOrder({ ...offerIntent, recipient: gift }, '0', '1')
    ).toThrow(/recipient/);
    order.components.consideration[0].recipient = buyer;
    expect(() => validateMarketOrder(offerIntent, order.components)).toThrow(
      /destination/
    );
    expect(MARKET_OPENSEA_CONDUIT).not.toBe(MARKET_SEAPORT);
  });
});
