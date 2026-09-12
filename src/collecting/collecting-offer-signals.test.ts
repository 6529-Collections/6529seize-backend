import { TypedDataEncoder } from 'ethers';
import { MEMES_CONTRACT } from '@/constants';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { CollectingAsset } from '@/collecting/collecting.types';
import { collectOfferSignals } from '@/collecting/collecting-offer-signals';
import { OfferAnalysisRequest } from '@/collecting/collecting-offer-analysis.types';
import { buildMarketOrder } from '@/marketplace/seaport.builder';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { normalizeOpenSeaOrder } from '@/market-depth/opensea-normalizer';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';

const now = new Date('2026-09-12T01:00:00Z');
const payer = '0x1111111111111111111111111111111111111111';
const maker = '0x2222222222222222222222222222222222222222';
const contract = MEMES_CONTRACT.toLowerCase();
const asset: CollectingAsset = {
  asset_key: collectingAssetKey(contract, '1'),
  chain_id: 1,
  contract,
  token_id: '1',
  family: 'memes',
  name: 'Meme 1',
  image_url: null,
  artist_ids: [],
  season: 1,
  traits: [],
  hodl_rate: 1,
  tdh_eligible: true
};
const request: OfferAnalysisRequest = {
  profile_id: 'profile',
  wallet: payer,
  recipient: payer,
  acknowledge_external_recipient: false,
  expires_at: now.getTime() / 1000 + 86400,
  assets: [{ asset_key: asset.asset_key, quantity: '1' }],
  method: { kind: 'match_bid' }
};

function indexed(
  side: 'ask' | 'bid',
  total = '100',
  quantity = '1',
  seller = maker
): CurrentMarketDepthOrder {
  const order = buildMarketOrder(
    {
      kind: side === 'ask' ? 'LIST' : 'OFFER',
      chainId: 1,
      wallet: seller,
      recipient: seller,
      asset: { contract, tokenId: '1', standard: 'ERC1155' },
      quantity,
      currency: side === 'ask' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
      maxTotalWei: total,
      minNetWei: total,
      fees: [],
      includeOptionalCreatorFees: false,
      startTime: String(now.getTime() / 1000 - 100),
      endTime: String(now.getTime() / 1000 + 3600)
    },
    '0',
    total
  ).order;
  const raw = {
    chain: 'ethereum',
    protocol_address: MARKET_SEAPORT,
    order_hash: TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      order.components
    ),
    protocol_data: { parameters: order.components },
    remaining_quantity: quantity,
    status: 'ACTIVE',
    price:
      side === 'ask'
        ? { current: { value: total, decimals: 18, currency: 'ETH' } }
        : { value: total, decimals: 18, currency: 'WETH' }
  };
  const normalized = normalizeOpenSeaOrder(raw, {
    side,
    contract,
    collectionSlug: 'the-memes-by-6529',
    observedAt: new Date(now.getTime() - 10000)
  });
  if (!normalized.order) throw new Error('Fixture order rejected');
  return {
    ...normalized.order,
    snapshot_id: 'snapshot',
    chain: 'ethereum',
    chain_id: '1'
  };
}
function book(
  orders: CurrentMarketDepthOrder[],
  patch: Partial<CurrentMarketDepthSnapshot['snapshot']> = {}
): CurrentMarketDepthSnapshot {
  return {
    snapshot: {
      id: 'snapshot',
      chain: 'ethereum',
      chain_id: '1',
      contract,
      collection_slug: 'the-memes-by-6529',
      collection_id: null,
      source: 'opensea',
      schema_version: 1,
      normalizer_version: '1',
      started_at: new Date(now.getTime() - 10000),
      completed_at: new Date(now.getTime() - 5000),
      raw_order_count: orders.length,
      order_count: orders.length,
      ask_count: orders.filter((order) => order.side === 'ask').length,
      bid_count: orders.filter((order) => order.side === 'bid').length,
      unsupported_count: 0,
      skipped_count: 0,
      event_count: 0,
      ...patch
    },
    orders
  };
}
function signal(
  orders: CurrentMarketDepthOrder[],
  input = request,
  snapshotPatch: Partial<CurrentMarketDepthSnapshot['snapshot']> = {}
) {
  return collectOfferSignals(
    input,
    [asset],
    [book(orders, snapshotPatch)],
    [payer],
    now.getTime()
  ).signals.get(asset.asset_key)!;
}

describe('indexed offer calculation references', () => {
  it('selects top applicable WETH bid and lowest applicable ask, explicitly without live funding claims', () => {
    const result = signal([
      indexed('bid', '100'),
      indexed('bid', '200'),
      indexed('ask', '400'),
      indexed('ask', '300')
    ]);
    expect(result.bid).toMatchObject({
      unit_amount_wei: '200',
      currency: MARKET_WETH,
      verification: 'OBSERVED_NOT_CHAIN_VERIFIED',
      funding: 'UNKNOWN'
    });
    expect(result.ask).toMatchObject({
      unit_amount_wei: '300',
      currency: MARKET_ZERO_ADDRESS
    });
    expect(result.distinct_ask_makers).toBe(1);
    expect(result.coverage_complete).toBe(true);
  });

  it.each([
    { status: 'CANCELLED' as const },
    { is_private: true },
    { scope: 'collection' as const, token_id: null },
    { scope: 'trait' as const },
    { is_executable: null },
    { currency_decimals: 6 },
    { maker: payer },
    { order_id: `0x${'ff'.repeat(32)}` },
    { remaining_quantity: '0' }
  ])('excludes unsupported or inapplicable observations: %j', (patch) => {
    expect(signal([{ ...indexed('bid'), ...patch }]).bid).toBeUndefined();
  });

  it('excludes both payer and profile sibling quotes by signed maker identity', () => {
    const order = indexed('bid', '100', '1', maker);
    const result = collectOfferSignals(
      request,
      [asset],
      [book([order])],
      [payer, maker],
      now.getTime()
    );
    expect(result.signals.get(asset.asset_key)?.bid).toBeUndefined();
  });

  it('does not quote one-unit liquidity for a larger desired quantity or divide full-fill orders', () => {
    const two = {
      ...request,
      assets: [{ asset_key: asset.asset_key, quantity: '2' }]
    };
    expect(signal([indexed('ask')], two).ask).toBeUndefined();
    expect(signal([indexed('ask', '200', '2')]).ask).toBeUndefined();
    expect(signal([indexed('ask', '200', '2')], two).ask).toMatchObject({
      quantity: '2',
      total_amount_wei: '200',
      unit_amount_wei: '100'
    });
  });

  it('ignores stale snapshots and does not certify truncated indexed coverage', () => {
    const stale = signal([indexed('bid')], request, {
      started_at: new Date(now.getTime() - 3600001)
    });
    expect(stale.bid).toBeUndefined();
    expect(stale.reason_codes).toContain('STALE_MARKET_DATA');
    const truncated = signal([indexed('ask')], request, { order_count: 2 });
    expect(truncated.ask).toBeDefined();
    expect(truncated.coverage_complete).toBe(false);
  });

  it.each([
    new Date(now.getTime() - 3600001),
    new Date(now.getTime() + 1),
    new Date('invalid')
  ])(
    'does not re-age stale or invalid row observations when a snapshot completes freshly: %s',
    (observed_at) => {
      const result = signal([{ ...indexed('bid'), observed_at }]);
      expect(result.bid).toBeUndefined();
      expect(result.coverage_complete).toBe(false);
      expect(result.reason_codes).toContain('STALE_MARKET_DATA');
    }
  );

  it('rejects a future snapshot completion even when its start time is in the past', () => {
    const result = signal([indexed('bid')], request, {
      completed_at: new Date(now.getTime() + 1)
    });
    expect(result.bid).toBeUndefined();
    expect(result.coverage_complete).toBe(false);
  });
});
