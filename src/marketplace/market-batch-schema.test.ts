import {
  MARKET_BATCH_LIMITS,
  marketBatchPrepareSchema
} from '@/marketplace/market-batch.schema';
import {
  BATCH_BUYER,
  BATCH_OWN,
  BATCH_FREN
} from '@/marketplace/market-batch.test-fixture';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

function request() {
  return {
    kind: 'BUY_BATCH',
    profile_id: 'profile',
    wallet: BATCH_BUYER,
    currency: MARKET_ZERO_ADDRESS,
    execution_policy: 'ALL_OR_REVERT',
    amount_wei: '200',
    items: [
      {
        asset_key: 'memes:73',
        order: {
          protocol_address: MARKET_SEAPORT,
          order_hash: `0x${'1'.repeat(64)}`
        },
        quantity: '2',
        amount_wei: '200',
        allocations: [
          {
            recipient: BATCH_OWN,
            quantity: '1',
            acknowledge_external_recipient: false
          },
          {
            recipient: BATCH_FREN,
            quantity: '1',
            acknowledge_external_recipient: true
          }
        ]
      }
    ]
  };
}

describe('strict batch request', () => {
  it('accepts one multi-edition order allocated across own and third-party recipients', () => {
    expect(
      marketBatchPrepareSchema.parse(request()).items[0].allocations
    ).toHaveLength(2);
  });
  it.each(['signature', 'calldata', 'recipient', 'asset_key'])(
    'rejects client supplied %s at batch level',
    (field) => {
      expect(
        marketBatchPrepareSchema.safeParse({
          ...request(),
          [field]: 'unexpected'
        }).success
      ).toBe(false);
    }
  );
  it('rejects duplicate exact orders, including address/hash case variants', () => {
    const value = request();
    value.items.push({ ...value.items[0] });
    value.amount_wei = '400';
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
  });
  it.each(['0', '-1', '01', '1.5', '1e2', '9'.repeat(79)])(
    'rejects invalid quantity %s',
    (quantity) => {
      const value = request();
      value.items[0].quantity = quantity;
      expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
    }
  );
  it('rejects total and allocation sum mismatches', () => {
    expect(
      marketBatchPrepareSchema.safeParse({ ...request(), amount_wei: '201' })
        .success
    ).toBe(false);
    const value = request();
    value.items[0].allocations[0].quantity = '2';
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
  });
  it('rejects zero and duplicate recipient addresses', () => {
    const value = request();
    value.items[0].allocations[1].recipient = BATCH_OWN;
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
    value.items[0].allocations[1].recipient = MARKET_ZERO_ADDRESS;
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
  });
  it('bounds order count without introducing a financial cap', () => {
    const value = request();
    const price = BigInt(`0x1${'0'.repeat(50)}`).toString();
    value.amount_wei = price;
    value.items[0].amount_wei = price;
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(true);
    value.items = Array.from(
      { length: MARKET_BATCH_LIMITS.max_orders + 1 },
      (_, index) => ({
        ...value.items[0],
        amount_wei: '1',
        order: {
          protocol_address: MARKET_SEAPORT,
          order_hash: `0x${index.toString(16).padStart(64, '0')}`
        }
      })
    );
    value.amount_wei = String(value.items.length);
    expect(marketBatchPrepareSchema.safeParse(value).success).toBe(false);
  });
});
