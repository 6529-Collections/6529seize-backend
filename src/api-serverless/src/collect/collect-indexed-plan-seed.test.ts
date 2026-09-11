import { collectingService } from '@/collecting/collecting.service';
import { CollectingAsset } from '@/collecting/collecting.types';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot
} from '@/market-depth/market-depth.types';
import { describeIndexedMarketListing } from '@/marketplace/provider.opensea';
import {
  MarketDiscoveredOrder,
  MarketValidationError
} from '@/marketplace/provider.types';
import { MEMES_CONTRACT } from '@/constants';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { seedCollectPlanFromIndex } from './collect-indexed-plan-seed';
import { buildMarketOrder } from '@/marketplace/seaport.builder';
import { TypedDataEncoder } from 'ethers';
import { SEAPORT_ORDER_TYPES } from '@/marketplace/seaport.schema';
import { CustomApiCompliantException } from '@/exceptions';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/api/market-depth/market-depth-api.db', () => ({
  marketDepthApiDb: { getBooks: jest.fn() }
}));
jest.mock('@/marketplace/provider.opensea', () => ({
  describeIndexedMarketListing: jest.fn()
}));

const now = Date.parse('2026-09-11T23:00:00Z');
const maker = '0x1111111111111111111111111111111111111111';
const mine = '0x2222222222222222222222222222222222222222';
const key = (id: string) => `1:${MEMES_CONTRACT.toLowerCase()}:${id}`;
function asset(id: string): CollectingAsset {
  return {
    asset_key: key(id),
    chain_id: 1,
    contract: MEMES_CONTRACT,
    token_id: id,
    family: 'memes',
    name: id,
    image_url: null,
    artist_ids: [],
    season: 1,
    traits: [],
    hodl_rate: null,
    tdh_eligible: false
  };
}
function order(
  id: string,
  price = '100',
  seller = maker
): CurrentMarketDepthOrder {
  const hash = `0x${BigInt(id).toString(16).padStart(64, '0')}`;
  const unit: MarketDiscoveredOrder = {
    identity: { protocolAddress: MARKET_SEAPORT, orderHash: hash },
    asset: {
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenId: id,
      standard: 'ERC1155'
    },
    maker: seller,
    recipient: seller,
    side: 'LISTING',
    quantity: '1',
    totalWei: price,
    unitTotalWei: price,
    netWei: price,
    fees: [],
    currency: MARKET_ZERO_ADDRESS,
    startTime: String(now / 1000 - 60),
    endTime: String(now / 1000 + 86400)
  };
  return {
    order_id: hash,
    contract: MEMES_CONTRACT,
    token_id: id,
    side: 'ask',
    status: 'ACTIVE',
    is_private: false,
    scope: 'token',
    is_executable: true,
    source: 'opensea',
    currency_contract: MARKET_ZERO_ADDRESS,
    currency_decimals: 18,
    remaining_quantity: '3',
    source_data: unit
  } as unknown as CurrentMarketDepthOrder;
}
function book(
  orders: CurrentMarketDepthOrder[],
  total = orders.length
): CurrentMarketDepthSnapshot {
  return {
    snapshot: {
      id: 'snapshot',
      completed_at: new Date(now - 1000),
      ask_count: total
    },
    orders
  } as CurrentMarketDepthSnapshot;
}
function setup(ids: string[], books = [book(ids.map((id) => order(id)))]) {
  jest.mocked(collectingService.getCatalog).mockResolvedValue({
    version: 'v',
    chain_id: 1,
    assets: ids.map(asset),
    seasons: [],
    artists: [],
    pebbles_traits: [],
    tdh_snapshot: null
  });
  jest.mocked(marketDepthApiDb.getBooks).mockResolvedValue(books);
  return {
    analysis: {
      catalog_version: 'v',
      account: {
        profile_id: 'profile',
        consolidation_key: 'group',
        membership_hash: 'membership',
        wallets: [mine]
      }
    },
    assetKeys: ids.map(key),
    gasReservePerOrderWei: '7',
    now
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(describeIndexedMarketListing)
    .mockImplementation((value) => value as MarketDiscoveredOrder);
});

it('accounts for an entire 546-NFT season universe in one indexed read without a TDH-eligibility requirement', async () => {
  const options = setup(
    Array.from({ length: 546 }, (_, index) => String(index + 1))
  );
  const result = await seedCollectPlanFromIndex(options);
  expect(marketDepthApiDb.getBooks).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    checked_asset_count: 546,
    unavailable_asset_count: 0,
    indexed_ask_count: 546,
    source: 'OPENSEA_COMPLETE_INDEX'
  });
  expect(result?.candidates).toHaveLength(546);
  expect(result?.candidates[0]).toMatchObject({
    quantity_available: '3',
    unit_price_wei: '100',
    group_cost_wei: '7',
    inventory_key: `${maker}:${key('1')}`
  });
  expect(result?.candidates[0].valid_until).toBe(
    new Date(now - 1000 + 3600000).toISOString()
  );
});

it('keeps the cheapest exact supported ask, excludes own wallets, and accounts for missing liquidity', async () => {
  const options = setup(
    ['1', '2', '3'],
    [book([order('1', '200'), order('1', '99'), order('2', '1', mine)])]
  );
  const result = await seedCollectPlanFromIndex(options);
  expect(result).toMatchObject({
    checked_asset_count: 3,
    unavailable_asset_count: 2
  });
  expect(result?.candidates).toHaveLength(1);
  expect(result?.candidates[0].unit_price_wei).toBe('99');
  expect(result?.candidates[0].candidate_id).toContain(
    result?.candidates[0].order_id
  );
});

it.each(['missing', 'stale', 'future', 'truncated'] as const)(
  'retains the scanner for %s index coverage',
  async (state) => {
    const snapshot = book([order('1')]);
    if (state === 'stale')
      snapshot.snapshot.completed_at = new Date(now - 3600000);
    if (state === 'future') snapshot.snapshot.completed_at = new Date(now + 1);
    if (state === 'truncated') snapshot.snapshot.ask_count = 10001;
    expect(
      await seedCollectPlanFromIndex(
        setup(['1'], state === 'missing' ? [] : [snapshot])
      )
    ).toBeNull();
  }
);

it('declines a catalog revision or missing asset without an index read', async () => {
  const options = setup(['1']);
  expect(
    await seedCollectPlanFromIndex({
      ...options,
      analysis: { ...options.analysis, catalog_version: 'old' }
    })
  ).toBeNull();
  expect(
    await seedCollectPlanFromIndex({ ...options, assetKeys: [key('2')] })
  ).toBeNull();
  expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
});

it('distinguishes a complete empty index from an unavailable index', async () => {
  expect(
    await seedCollectPlanFromIndex(setup(['1', '2'], [book([])]))
  ).toMatchObject({
    candidates: [],
    checked_asset_count: 2,
    unavailable_asset_count: 2,
    indexed_ask_count: 0
  });
});

it('keeps unsupported lots and malformed orders out of the unit-fill planner', async () => {
  const options = setup(
    ['1', '2', '3'],
    [book([order('1'), order('2'), { ...order('3'), status: 'CANCELLED' }])]
  );
  jest
    .mocked(describeIndexedMarketListing)
    .mockReturnValueOnce({
      ...(order('1').source_data as unknown as MarketDiscoveredOrder),
      quantity: '2'
    })
    .mockImplementationOnce(() => {
      throw new MarketValidationError('ORDER_MISMATCH', 'Invalid signed order');
    });
  expect(await seedCollectPlanFromIndex(options)).toMatchObject({
    candidates: [],
    unavailable_asset_count: 3
  });
});

it('does not truncate a larger candidate universe and call it complete', async () => {
  const options = setup(
    Array.from({ length: 2001 }, (_, index) => String(index + 1))
  );
  expect(await seedCollectPlanFromIndex(options)).toBeNull();
});

it.each(['valid', 'invalid-start', 'invalid-end', 'overflow-end'])(
  'validates real signed-order timestamps and expiry for %s source data',
  async (state) => {
    const built = buildMarketOrder(
      {
        kind: 'LIST',
        chainId: 1,
        wallet: maker,
        recipient: maker,
        asset: {
          contract: MEMES_CONTRACT.toLowerCase(),
          tokenId: '1',
          standard: 'ERC1155'
        },
        quantity: '3',
        currency: MARKET_ZERO_ADDRESS,
        maxTotalWei: '300',
        minNetWei: '300',
        fees: [],
        includeOptionalCreatorFees: false,
        startTime: String(now / 1000 - 60),
        endTime: String(now / 1000 + 60)
      },
      '0',
      '1'
    ).order;
    const parameters = structuredClone(built.components);
    parameters.orderType = 1;
    const validHash = TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      parameters
    );
    if (state === 'invalid-start') parameters.startTime = 'NaN';
    if (state === 'invalid-end') parameters.endTime = 'NaN';
    if (state === 'overflow-end') parameters.endTime = '8640000000001';
    const hash =
      state === 'overflow-end'
        ? TypedDataEncoder.hashStruct(
            'OrderComponents',
            SEAPORT_ORDER_TYPES,
            parameters
          )
        : validHash;
    const indexedOrder = {
      ...order('1'),
      order_id: hash,
      source_data: JSON.parse(
        JSON.stringify({
          chain: 'ethereum',
          protocol_address: MARKET_SEAPORT,
          order_hash: hash,
          protocol_data: { parameters },
          remaining_quantity: '3'
        })
      ) as CurrentMarketDepthOrder['source_data']
    };
    const options = setup(['1'], [book([indexedOrder])]);
    const actual = jest.requireActual<
      typeof import('@/marketplace/provider.opensea')
    >('@/marketplace/provider.opensea');
    jest
      .mocked(describeIndexedMarketListing)
      .mockImplementation(actual.describeIndexedMarketListing);
    const result = await seedCollectPlanFromIndex(options);
    expect(result?.candidates).toHaveLength(state === 'valid' ? 1 : 0);
    if (state === 'valid') {
      expect(result?.candidates[0].unit_price_wei).toBe('100');
      expect(result?.candidates[0].valid_until).toBe(
        new Date(now + 60000).toISOString()
      );
    }
  }
);

it('retains the scanner when a collection partition becomes unavailable', async () => {
  const options = setup(['1']);
  jest
    .mocked(marketDepthApiDb.getBooks)
    .mockRejectedValue(
      new CustomApiCompliantException(
        503,
        'The indexed collection is temporarily unavailable.'
      )
    );
  expect(await seedCollectPlanFromIndex(options)).toBeNull();
});
