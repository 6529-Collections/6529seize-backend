import { buildMarketOrder } from '@/marketplace/seaport.builder';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { TypedDataEncoder } from 'ethers';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  MARKET_OPENSEA_ZONE
} from '@/marketplace/seaport.registry';
import { MEMES_CONTRACT } from '@/constants';
import { CollectingAsset } from '@/collecting/collecting.types';
import { CollectingTdhSource } from '@/collecting/collecting-tdh-projection';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import { normalizeOpenSeaOrder } from '@/market-depth/opensea-normalizer';
import { collectTdhTargetCandidates } from '@/api/collect/collect-tdh-target-candidates';

const now = new Date('2026-09-11T22:00:00Z');
const maker = '0x1111111111111111111111111111111111111111';
const feeRecipient = '0x2222222222222222222222222222222222222222';
function asset(id = '1', rate = 1): CollectingAsset {
  return {
    asset_key: `1:${MEMES_CONTRACT.toLowerCase()}:${id}`,
    chain_id: 1,
    contract: MEMES_CONTRACT,
    token_id: id,
    family: 'memes',
    name: `Meme ${id}`,
    image_url: null,
    artist_ids: [],
    season: 1,
    traits: [],
    hodl_rate: rate,
    tdh_eligible: true
  };
}
function order(
  tokenId = '1',
  total = '100',
  quantity = '1',
  fee = '0',
  partial = false
): CurrentMarketDepthOrder {
  const built = buildMarketOrder(
    {
      kind: 'LIST',
      chainId: 1,
      wallet: maker,
      recipient: maker,
      asset: {
        contract: MEMES_CONTRACT.toLowerCase(),
        tokenId,
        standard: 'ERC1155'
      },
      quantity,
      currency: MARKET_ZERO_ADDRESS,
      maxTotalWei: total,
      minNetWei: (BigInt(total) - BigInt(fee)).toString(),
      fees: fee === '0' ? [] : [{ recipient: feeRecipient, amountWei: fee }],
      includeOptionalCreatorFees: false,
      startTime: String(now.getTime() / 1000 - 60),
      endTime: String(now.getTime() / 1000 + 3600)
    },
    '0',
    '1'
  ).order;
  const components = { ...built.components, orderType: partial ? 1 : 0 };
  const raw = {
    chain: 'ethereum',
    protocol_address: MARKET_SEAPORT,
    order_hash: TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      components
    ),
    protocol_data: { parameters: components },
    remaining_quantity: quantity,
    status: 'ACTIVE',
    price: { current: { value: total, decimals: 18, currency: 'ETH' } }
  };
  const normalized = normalizeOpenSeaOrder(raw, {
    side: 'ask',
    contract: MEMES_CONTRACT,
    collectionSlug: 'thememes6529',
    observedAt: now
  }).order!;
  return {
    ...normalized,
    snapshot_id: 'snapshot',
    chain: 'ethereum',
    chain_id: '1'
  };
}
function book(orders: CurrentMarketDepthOrder[]): CurrentMarketDepthSnapshot {
  return {
    snapshot: {
      id: 'snapshot',
      source: 'opensea',
      chain: 'ethereum',
      chain_id: '1',
      contract: MEMES_CONTRACT,
      collection_slug: 'thememes6529',
      collection_id: null,
      schema_version: 1,
      normalizer_version: 'test',
      started_at: now,
      completed_at: now,
      raw_order_count: orders.length,
      order_count: orders.length,
      ask_count: orders.length,
      bid_count: 0,
      unsupported_count: 0,
      skipped_count: 0,
      event_count: 0
    },
    orders
  };
}

function source(
  wallets: string[] = ['0x3333333333333333333333333333333333333333']
): CollectingTdhSource {
  return {
    account: {
      profile_id: 'profile',
      wallets,
      consolidation_key: 'key',
      membership_hash: 'hash'
    },
    input: {
      snapshot_block: 1,
      snapshot_timestamp: now.toISOString(),
      evaluated_at: now.toISOString(),
      rules_version: 'rules',
      wallets,
      tokens: [1, 2].map((token_id) => ({
        contract: MEMES_CONTRACT,
        token_id,
        family: 'memes',
        hodl_rate: 1,
        minted_at: '2025-01-01T00:00:00Z',
        calculation_edition_size: 100
      })),
      transactions: [],
      seasons: [],
      transfers: []
    },
    official: { base_tdh: 0, boosted_tdh: 0, boost: 1, full_memes_sets: 0 }
  };
}
function capture(
  orders: CurrentMarketDepthOrder[],
  fixture = source(),
  snapshot = book(orders)
) {
  return collectTdhTargetCandidates(
    fixture,
    [asset('1'), asset('2')],
    [{ family: 'memes', books: [snapshot] }],
    now.getTime(),
    now.getTime() + 20000
  );
}
beforeEach(() => jest.useFakeTimers().setSystemTime(now));
afterEach(() => jest.useRealTimers());

it('preserves exact per-fee-divisible unit basis and independent remaining quantity', () => {
  const result = capture([order('1', '400', '4', '4', true)]);
  expect(result.listings[0].candidate).toMatchObject({
    quantity_step: 1,
    available_quantity: 4,
    step_cost_wei: '100',
    step_fees_wei: '1'
  });
  expect(result.listings[0].order).toMatchObject({
    quantity: '1',
    availableQuantity: '4'
  });
  expect(result.coverage).toMatchObject({
    index_complete: true,
    market_complete: false,
    indexed_ask_count: 1,
    candidate_count: 1
  });
});
it.each([false, true])(
  'uses the complete remaining lot when an individual fee cannot divide: %s',
  (partial) => {
    const result = capture([order('1', '200', '2', '1', partial)]);
    expect(result.listings[0].candidate).toMatchObject({
      quantity_step: 2,
      available_quantity: 2,
      step_cost_wei: '200',
      step_fees_wei: '1'
    });
  }
);
it('excludes own-profile sellers, invalid hashes and unsupported native currencies', () => {
  expect(capture([order()], source([maker])).listings).toEqual([]);
  expect(
    capture([{ ...order(), order_id: '0x' + 'f'.repeat(64) }]).listings
  ).toEqual([]);
  expect(capture([{ ...order(), currency_decimals: 6 }]).listings).toEqual([]);
});
it('excludes stale books and exposes absent or truncated captured coverage', () => {
  const stale = book([order()]);
  stale.snapshot.completed_at = new Date(now.getTime() - 3600000);
  expect(capture(stale.orders, source(), stale)).toMatchObject({
    listings: [],
    coverage: {
      index_complete: false,
      candidate_count: 0,
      excluded_ask_count: 1
    }
  });
  const truncated = book([order()]);
  truncated.snapshot.ask_count = 3;
  expect(capture(truncated.orders, source(), truncated).coverage).toMatchObject(
    { index_complete: false, indexed_ask_count: 3, candidate_count: 1 }
  );
});
it('deduplicates pinned identities and rejects a mismatched canonical asset key', () => {
  expect(capture([order(), order()]).listings).toHaveLength(1);
  const changed = { ...asset(), asset_key: `1:${MEMES_CONTRACT}:99` };
  expect(
    collectTdhTargetCandidates(
      source(),
      [changed],
      [{ family: 'memes', books: [book([order()])] }],
      now.getTime(),
      now.getTime() + 20000
    ).listings
  ).toEqual([]);
});
it('refuses unproven restricted multi-unit Memes while retaining proven quantity-one shape', () => {
  const restrict = (indexed: CurrentMarketDepthOrder) => {
    const raw = JSON.parse(JSON.stringify(indexed.source_data));
    raw.protocol_data.parameters.zone = MARKET_OPENSEA_ZONE;
    raw.protocol_data.parameters.orderType = 2;
    raw.order_hash = TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      raw.protocol_data.parameters
    );
    return { ...indexed, source_data: raw, order_id: raw.order_hash };
  };
  expect(capture([restrict(order('1', '200', '2'))]).listings).toEqual([]);
  expect(capture([restrict(order())]).listings).toHaveLength(1);
});
it('exposes the work deadline instead of reading additional asks indefinitely', () => {
  const result = collectTdhTargetCandidates(
    source(),
    [asset()],
    [{ family: 'memes', books: [book([order()])] }],
    now.getTime(),
    now.getTime()
  );
  expect(result).toMatchObject({
    listings: [],
    coverage: { index_complete: false, evaluated_ask_count: 0 }
  });
});

it('does not refresh an old row or a long scan merely because snapshot completion is recent', () => {
  const staleRow = {
    ...order(),
    observed_at: new Date(now.getTime() - 3600001)
  };
  expect(capture([staleRow])).toMatchObject({
    listings: [],
    coverage: { index_complete: false }
  });
  const longScan = book([order()]);
  longScan.snapshot.started_at = new Date(now.getTime() - 3600001);
  expect(capture(longScan.orders, source(), longScan)).toMatchObject({
    listings: [],
    coverage: { index_complete: false }
  });
});
it.each([new Date(NaN), new Date(now.getTime() + 1)])(
  'excludes invalid/future row observations: %s',
  (observed_at) => {
    expect(capture([{ ...order(), observed_at }]).listings).toEqual([]);
  }
);
it('caps advertised validity at the oldest relevant source observation', () => {
  const older = new Date(now.getTime() - 1800000);
  const result = capture([{ ...order(), observed_at: older }]);
  expect(result.listings[0].valid_until).toBe(
    new Date(older.getTime() + 3600000).toISOString()
  );
  expect(result.coverage.observed_at).toBe(older.toISOString());
});
