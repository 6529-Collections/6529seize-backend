import { buildMarketOrder } from '@/marketplace/seaport.builder';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { TypedDataEncoder } from 'ethers';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { MEMES_CONTRACT } from '@/constants';
import { CollectingAsset } from '@/collecting/collecting.types';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import { normalizeOpenSeaOrder } from '@/market-depth/opensea-normalizer';
import {
  baseTdhRateHundredths,
  compareTdhListings,
  getCollectTdhListings,
  rankIndexedTdhListings
} from './collect-tdh-listings.service';
import { collectingService } from '@/collecting/collecting.service';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { redisCachedWithRefreshLease } from '@/redis';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/api/market-depth/market-depth-api.db', () => ({
  marketDepthApiDb: { getBooks: jest.fn() }
}));
jest.mock('@/redis', () => ({
  getRedisCacheKeyForPath: (key: string) => key,
  redisCachedWithRefreshLease: jest.fn((_key, _ttl, work) => work())
}));

const now = new Date('2026-09-11T22:00:00Z');
const maker = '0x1111111111111111111111111111111111111111';
const feeRecipient = '0x2222222222222222222222222222222222222222';
function asset(id = '1', rate = 1): CollectingAsset {
  return {
    asset_key: `1:${MEMES_CONTRACT}:${id}`,
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
function rank(assets: CollectingAsset[], orders: CurrentMarketDepthOrder[]) {
  return rankIndexedTdhListings(
    'memes',
    'catalog',
    assets,
    [book(orders)],
    now.getTime()
  );
}

describe('indexed base TDH listing discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it.each([null, NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER])(
    'excludes unusable rates: %s',
    (rate) => {
      expect(baseTdhRateHundredths(rate)).toBeNull();
    }
  );
  it('uses production hundredths rounding without a hidden horizon', () => {
    expect(baseTdhRateHundredths(1.234)).toBe(BigInt(123));
    expect(baseTdhRateHundredths(1.236)).toBe(BigInt(124));
  });
  it('ranks higher-priced high-rate NFTs before cheaper low-rate NFTs across the full index', () => {
    const result = rank(
      [asset('1', 1), asset('2', 10)],
      [order('1', '100'), order('2', '200')]
    );
    expect(result.entries.map((entry) => entry.asset.token_id)).toEqual([
      '2',
      '1'
    ]);
    expect(result.entries[0]).toMatchObject({
      purchase_quantity: '1',
      purchase_cost_wei: '200',
      rate_hundredths: '1000',
      base_tdh_per_day_hundredths: '1000'
    });
    expect(result.coverage_complete).toBe(true);
  });
  it('compares neighboring wei above Number precision exactly and breaks ties deterministically', () => {
    const result = rank(
      [asset('1'), asset('2')],
      [order('1', '9007199254740993'), order('2', '9007199254740992')]
    );
    expect(result.entries.map((entry) => entry.asset.token_id)).toEqual([
      '2',
      '1'
    ]);
    expect(compareTdhListings(result.entries[0], result.entries[0])).toBe(0);
  });
  it('includes every signed fee and describes an exact one-copy fill when supported', () => {
    const result = rank([asset()], [order('1', '200', '2', '2', true)]);
    expect(result.entries[0]).toMatchObject({
      available_quantity: '2',
      purchase_quantity: '1',
      purchase_cost_wei: '100',
      base_tdh_per_day_hundredths: '100',
      order: {
        quantity: '1',
        purchase_quantity: '1',
        quantity_step: '1',
        available_quantity: '2',
        total_wei: '100',
        fees: [{ amount_wei: '1' }]
      }
    });
  });
  it('preserves an indivisible lot when a signed fee cannot divide into a one-copy fill', () => {
    const result = rank([asset('1', 2)], [order('1', '200', '2', '1', true)]);
    expect(result.entries[0]).toMatchObject({
      available_quantity: '2',
      purchase_quantity: '2',
      purchase_cost_wei: '200',
      base_tdh_per_day_hundredths: '400',
      order: {
        quantity: '2',
        purchase_quantity: '2',
        quantity_step: '2',
        available_quantity: '2'
      }
    });
  });
  it('preserves actual remaining availability independently from the unit quote and original quantity', () => {
    const indexed = order('1', '400', '4', '4', true);
    indexed.remaining_quantity = '3';
    const result = rank([asset()], [indexed]);
    expect(result.entries[0]).toMatchObject({
      available_quantity: '3',
      purchase_quantity: '1',
      purchase_cost_wei: '100',
      order: {
        quantity: '1',
        purchase_quantity: '1',
        quantity_step: '1',
        available_quantity: '3',
        total_wei: '100'
      }
    });
  });
  it('shows the best supported listing once per NFT', () => {
    const result = rank([asset()], [order('1', '200'), order('1', '100')]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].purchase_cost_wei).toBe('100');
    expect(result.evaluated_ask_count).toBe(2);
  });
  it.each<Partial<CurrentMarketDepthOrder>>([
    { status: 'CANCELLED' },
    { status: 'FULFILLED' },
    { status: 'INACTIVE' },
    { is_private: true },
    { scope: 'collection' },
    { is_executable: false },
    { currency_contract: maker },
    { currency_decimals: 6 },
    { token_id: 'unknown' },
    { order_id: `0x${'a'.repeat(64)}` },
    { contract: maker }
  ])('excludes unsupported or unavailable indexed asks: %j', (changes) => {
    expect(rank([asset()], [{ ...order(), ...changes }]).entries).toEqual([]);
  });
  it('revalidates signed hashes instead of trusting indexed scalar price or identity', () => {
    const indexed = order();
    const raw = structuredClone(indexed.source_data) as {
      protocol_data: { parameters: { offerer: string } };
    };
    raw.protocol_data.parameters.offerer = feeRecipient;
    expect(rank([asset()], [{ ...indexed, source_data: raw }]).entries).toEqual(
      []
    );
  });
  it('does not return bearer order data or seller TDH and skips ineligible assets', () => {
    const result = rank(
      [asset(), { ...asset('2'), tdh_eligible: false }],
      [order(), order('2')]
    );
    expect(result.entries).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /signature|protocol_data|source_data|additional_tdh/
    );
  });
  it('distinguishes missing, empty and stale snapshots; reports a bounded index honestly', () => {
    const empty = rank([], []);
    expect(empty).toMatchObject({
      status: 'fresh',
      entries: [],
      coverage_complete: true
    });
    expect(
      rankIndexedTdhListings('memes', 'v', [], [], now.getTime())
    ).toMatchObject({
      status: 'unavailable',
      observed_at: null,
      coverage_complete: false
    });
    const bounded = book([order()]);
    bounded.snapshot.ask_count = 10002;
    expect(
      rankIndexedTdhListings(
        'memes',
        'v',
        [asset()],
        [bounded],
        now.getTime() + 3600001
      )
    ).toMatchObject({
      status: 'stale',
      coverage_complete: false,
      indexed_ask_count: 10002,
      evaluated_ask_count: 1
    });
  });
  it('bounds evaluated asks across partitions and marks omitted liquidity incomplete', () => {
    const cancelled = { ...order(), status: 'CANCELLED' as const };
    const result = rankIndexedTdhListings(
      'memes',
      'v',
      [asset()],
      [
        book(Array.from({ length: 6000 }, () => cancelled)),
        book([...Array.from({ length: 4000 }, () => cancelled), order()])
      ],
      now.getTime()
    );
    expect(result).toMatchObject({
      evaluated_ask_count: 10000,
      indexed_ask_count: 10001,
      coverage_complete: false,
      entries: []
    });
  });
  it('advances across expired cached entries without an empty continuation page', async () => {
    const snapshot = rank(
      [asset('1'), asset('2'), asset('3'), asset('4')],
      [order('1'), order('2'), order('3'), order('4')]
    );
    for (const entry of snapshot.entries.slice(0, 2))
      entry.order.end_time = String(now.getTime() / 1000 - 1);
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(snapshot);
    const first = await getCollectTdhListings('memes', 1);
    expect(first.entries.map((entry) => entry.asset.token_id)).toEqual(['3']);
    expect(first.next).not.toBeNull();
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(snapshot);
    const second = await getCollectTdhListings('memes', 1, first.next!);
    expect(second.entries.map((entry) => entry.asset.token_id)).toEqual(['4']);
    expect(second.next).toBeNull();
    for (const entry of snapshot.entries)
      entry.order.end_time = String(now.getTime() / 1000 - 1);
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(snapshot);
    const empty = await getCollectTdhListings('memes', 1);
    expect(empty.entries).toEqual([]);
    expect(empty.next).toBeNull();
  });
  it('paginates with a family and content binding and rejects stale or cross-family cursors', async () => {
    jest.mocked(collectingService.getCatalog).mockResolvedValue({
      version: 'v',
      chain_id: 1,
      assets: [asset('1'), asset('2')],
      seasons: [],
      artists: [],
      pebbles_traits: [],
      tdh_snapshot: null
    });
    jest
      .mocked(marketDepthApiDb.getBooks)
      .mockResolvedValue([book([order('1'), order('2')])]);
    const first = await getCollectTdhListings('memes', 1);
    const second = await getCollectTdhListings('memes', 1, first.next!);
    expect(first.entries[0].asset.token_id).toBe('1');
    expect(second.entries[0].asset.token_id).toBe('2');
    expect(second.next).toBeNull();
    await expect(
      getCollectTdhListings('gradients', 1, first.next!)
    ).rejects.toMatchObject({ code: 'LISTINGS_CHANGED' });
    jest
      .mocked(marketDepthApiDb.getBooks)
      .mockResolvedValue([book([order('1', '999'), order('2')])]);
    await expect(
      getCollectTdhListings('memes', 1, first.next!)
    ).rejects.toMatchObject({ code: 'LISTINGS_CHANGED' });
  });
  it('does not advertise a continuation when only expired entries remain', async () => {
    const snapshot = rank([asset('1'), asset('2')], [order('1'), order('2')]);
    snapshot.entries[1].order.end_time = String(now.getTime() / 1000 - 1);
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(snapshot);
    const page = await getCollectTdhListings('memes', 1);
    expect(page.entries.map((entry) => entry.asset.token_id)).toEqual(['1']);
    expect(page.next).toBeNull();
  });
  it('reports a bounded retry when another instance is refreshing the index', async () => {
    jest.mocked(redisCachedWithRefreshLease).mockResolvedValueOnce(undefined);
    await expect(getCollectTdhListings('memes', 24)).rejects.toMatchObject({
      code: 'LISTINGS_REFRESHING'
    });
    expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
  });
});
