import { Result, TypedDataEncoder } from 'ethers';
import {
  buildMarketBatchTransaction,
  MARKET_BATCH_INTERFACE,
  validateMarketBatchTransaction
} from '@/marketplace/seaport-batch.builder';
import { MARKET_BATCH_LIMITS } from '@/marketplace/market-batch.schema';
import {
  BATCH_BUYER,
  BATCH_FREN,
  marketBatchFixture
} from '@/marketplace/market-batch.test-fixture';
import {
  MARKET_OPENSEA_ZONE,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import { validateMarketBatchZoneAuthorization } from '@/marketplace/market-batch-validation';
import {
  assertMarketBatchFlowLedger,
  DecodedItem
} from '@/marketplace/market-batch-flow-ledger';

function authorization(context = 0): string {
  const length = context < 2 ? 126 : context === 7 ? 166 : 146;
  const value = Buffer.alloc(length);
  Buffer.from(BATCH_BUYER.slice(2), 'hex').copy(value, 1);
  value.writeBigUInt64BE(BigInt(2000), 21);
  value[93] = context;
  return `0x${value.toString('hex')}`;
}

describe('native all-or-revert buyer mirror', () => {
  it('rejects a displayed asset key different from the token being purchased', () => {
    const { intent, materials, terms } = marketBatchFixture();
    intent.items[0].assetKey =
      '1:0x1111111111111111111111111111111111111111:999';
    expect(() => buildMarketBatchTransaction(intent, materials, terms)).toThrow(
      'artwork key'
    );
  });

  it.each(['recipient', 'payment', 'unconsumed-offer'])(
    'independently rejects %s flow conservation errors without using expected mapping generation',
    (change) => {
      const { intent, materials, terms } = marketBatchFixture();
      const tx = buildMarketBatchTransaction(intent, materials, terms);
      const decoded = MARKET_BATCH_INTERFACE.decodeFunctionData(
        'matchAdvancedOrders',
        tx.data
      );
      const items = (values: readonly Result[]) =>
        Array.from(values, (item) => item.toObject() as unknown as DecodedItem);
      const orders = Array.from(
        decoded.orders as readonly Result[],
        (order) => ({
          parameters: {
            offerer: order.parameters.offerer as string,
            offer: items(order.parameters.offer),
            consideration: items(order.parameters.consideration)
          },
          numerator: order.numerator as bigint,
          denominator: order.denominator as bigint
        })
      );
      if (change === 'recipient')
        orders[2].parameters.consideration[2].recipient = BATCH_BUYER;
      if (change === 'payment')
        orders[0].parameters.consideration[1].recipient = BATCH_FREN;
      if (change === 'unconsumed-offer') {
        orders[1].parameters.offer[0].startAmount = BigInt(6);
        orders[1].parameters.offer[0].endAmount = BigInt(6);
      }
      expect(() =>
        assertMarketBatchFlowLedger(
          intent,
          materials.map((material) => material.order),
          orders,
          decoded.fulfillments
        )
      ).toThrow();
    }
  );
  it('encodes all exact orders, partial fraction, allocations, fees and unsigned payer mirror', () => {
    const { intent, materials, terms } = marketBatchFixture();
    const tx = buildMarketBatchTransaction(intent, materials, terms);
    validateMarketBatchTransaction(intent, materials, terms, tx);
    const data = MARKET_BATCH_INTERFACE.decodeFunctionData(
      'matchAdvancedOrders',
      tx.data
    );
    expect(tx.value).toBe('300');
    expect(data.orders).toHaveLength(3);
    expect(data.orders[1].numerator).toBe(BigInt(2));
    expect(data.orders[1].denominator).toBe(BigInt(3));
    const mirror = data.orders[2];
    expect(mirror.parameters.offerer.toLowerCase()).toBe(BATCH_BUYER);
    expect(mirror.signature).toBe('0x');
    expect(mirror.parameters.zone).toBe(MARKET_ZERO_ADDRESS);
    expect(mirror.parameters.conduitKey).toBe(MARKET_ZERO_HASH);
    expect(mirror.parameters.consideration).toHaveLength(3);
    expect(mirror.parameters.consideration[2].recipient.toLowerCase()).toBe(
      BATCH_FREN
    );
    expect(data.fulfillments).toHaveLength(7);
    expect(buildMarketBatchTransaction(intent, materials, terms).data).toBe(
      tx.data
    );
  });

  it.each([
    'value',
    'from',
    'to',
    'chainId',
    'purpose',
    'approvalScope'
  ] as const)('rejects an altered %s transaction envelope', (field) => {
    const { intent, materials, terms } = marketBatchFixture();
    const tx = buildMarketBatchTransaction(intent, materials, terms);
    const bad = { ...tx, [field]: field === 'chainId' ? 2 : 'changed' };
    expect(() =>
      validateMarketBatchTransaction(intent, materials, terms, bad)
    ).toThrow();
  });

  it.each([
    'recipient',
    'allocation',
    'signature',
    'fraction',
    'missing-payment',
    'duplicate-payment',
    'missing-order',
    'criteria',
    'mirror-signed'
  ])('rejects %s calldata tampering', (change) => {
    const { intent, materials, terms } = marketBatchFixture();
    const tx = buildMarketBatchTransaction(intent, materials, terms);
    const decoded = MARKET_BATCH_INTERFACE.decodeFunctionData(
      'matchAdvancedOrders',
      tx.data
    );
    const args = decoded.toArray(true);
    const orders = args[0] as unknown[][];
    const mappings = args[2] as unknown[][];
    if (change === 'recipient') args[3] = BATCH_FREN;
    if (change === 'allocation')
      ((orders[2][0] as unknown[])[3] as unknown[][])[2][5] = BATCH_BUYER;
    if (change === 'signature') orders[0][3] = '0xabcd';
    if (change === 'fraction') orders[1][1] = BigInt(1);
    if (change === 'missing-payment') mappings.pop();
    if (change === 'duplicate-payment')
      mappings.push(mappings[mappings.length - 1]);
    if (change === 'missing-order') orders.splice(0, 1);
    if (change === 'criteria') args[1] = [[0, 0, 0, 0, []]];
    if (change === 'mirror-signed') orders[2][3] = '0x1122';
    tx.data = MARKET_BATCH_INTERFACE.encodeFunctionData(
      'matchAdvancedOrders',
      args
    );
    expect(() =>
      validateMarketBatchTransaction(intent, materials, terms, tx)
    ).toThrow();
  });

  it('rejects noncanonical appended data and a different function', () => {
    const { intent, materials, terms } = marketBatchFixture();
    const tx = buildMarketBatchTransaction(intent, materials, terms);
    expect(() =>
      validateMarketBatchTransaction(intent, materials, terms, {
        ...tx,
        data: `${tx.data}00`
      })
    ).toThrow();
    expect(() =>
      validateMarketBatchTransaction(intent, materials, terms, {
        ...tx,
        data: '0x12345678'
      })
    ).toThrow();
  });

  it('does not substitute missing material or a changed order identity', () => {
    const { intent, materials, terms } = marketBatchFixture();
    expect(() =>
      buildMarketBatchTransaction(intent, materials.slice(1), terms)
    ).toThrow();
    materials[0].order.orderHash = MARKET_ZERO_HASH;
    expect(() =>
      buildMarketBatchTransaction(intent, materials, terms)
    ).toThrow();
  });

  it('rejects unacknowledged external recipients and duplicate ERC721 selections', () => {
    const { intent, materials, terms } = marketBatchFixture();
    intent.items[1].allocations[1].acknowledgeExternalRecipient = false;
    expect(() =>
      buildMarketBatchTransaction(intent, materials, terms)
    ).toThrow();
    intent.items[1] = structuredClone(intent.items[0]);
    intent.items[1].intent.order!.orderHash = MARKET_ZERO_HASH;
    intent.totalWei = '200';
    expect(() =>
      buildMarketBatchTransaction(intent, materials, terms)
    ).toThrow();
  });

  it('supports the 128-order/256-allocation boundary and rejects one additional order', () => {
    const { intent, materials, terms } = marketBatchFixture(
      MARKET_BATCH_LIMITS.max_orders
    );
    const last = intent.items[intent.items.length - 1];
    last.intent.quantity = '3';
    last.intent.maxTotalWei = '300';
    last.intent.minNetWei = '270';
    last.intent.fees[0].amountWei = '30';
    last.allocations.push({
      recipient: BATCH_BUYER,
      quantity: '1',
      recipientInProfile: true,
      acknowledgeExternalRecipient: false
    });
    intent.totalWei = (BigInt(intent.totalWei) + BigInt(100)).toString();
    materials[materials.length - 1].order = validateMarketOrder(
      last.intent,
      materials[materials.length - 1].order.components
    );
    const tx = buildMarketBatchTransaction(intent, materials, terms);
    expect((tx.data.length - 2) / 2).toBeLessThan(
      MARKET_BATCH_LIMITS.max_calldata_bytes
    );
    validateMarketBatchTransaction(intent, materials, terms, tx);
    const data = MARKET_BATCH_INTERFACE.decodeFunctionData(
      'matchAdvancedOrders',
      tx.data
    );
    expect(data.orders).toHaveLength(129);
    expect(data.orders[128].parameters.consideration).toHaveLength(256);
    const tooMany = marketBatchFixture(MARKET_BATCH_LIMITS.max_orders + 1);
    expect(() =>
      buildMarketBatchTransaction(
        tooMany.intent,
        tooMany.materials,
        tooMany.terms
      )
    ).toThrow();
  });

  it('rejects authorization payloads whose aggregate calldata exceeds the resource limit', () => {
    const { intent, materials, terms } = marketBatchFixture(
      MARKET_BATCH_LIMITS.max_orders
    );
    for (const material of materials)
      material.signature = `0x${'11'.repeat(16384)}`;
    expect(() => buildMarketBatchTransaction(intent, materials, terms)).toThrow(
      'transaction data limit'
    );
  });

  it('accepts fresh restricted full ERC721 material but refuses unproven restricted ERC1155 multi-unit shape', () => {
    const { intent, materials, terms } = marketBatchFixture();
    for (let index = 0; index < 2; index++) {
      const components = materials[index].order.components;
      components.zone = MARKET_OPENSEA_ZONE;
      components.orderType += 2;
      intent.items[index].intent.order!.orderHash = TypedDataEncoder.hashStruct(
        'OrderComponents',
        SEAPORT_ORDER_TYPES,
        components
      );
      materials[index].order = validateMarketOrder(
        intent.items[index].intent,
        components
      );
      materials[index].extraData = authorization();
      if (index === 0)
        expect(() =>
          buildMarketBatchTransaction(intent, materials, terms)
        ).not.toThrow();
    }
    expect(() => buildMarketBatchTransaction(intent, materials, terms)).toThrow(
      'Restricted multi-edition'
    );
  });
});

describe('deployed SignedZone batch bindings', () => {
  it.each([0, 1, 7, 8, 9])(
    'parses supported context %s without assuming signature validity',
    (context) => {
      expect(() =>
        validateMarketBatchZoneAuthorization(
          authorization(context),
          BATCH_BUYER,
          '2000'
        )
      ).not.toThrow();
    }
  );
  it('rejects wrong payer, expired authorization, unknown contexts and trailing bytes', () => {
    expect(() =>
      validateMarketBatchZoneAuthorization(authorization(), BATCH_FREN, '2000')
    ).toThrow();
    expect(() =>
      validateMarketBatchZoneAuthorization(authorization(), BATCH_BUYER, '2001')
    ).toThrow();
    expect(() =>
      validateMarketBatchZoneAuthorization(
        authorization(6),
        BATCH_BUYER,
        '2000'
      )
    ).toThrow();
    expect(() =>
      validateMarketBatchZoneAuthorization(
        `${authorization()}00`,
        BATCH_BUYER,
        '2000'
      )
    ).toThrow();
  });
});
