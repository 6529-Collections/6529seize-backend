import { collectingService } from '@/collecting/collecting.service';
import { collectingDb } from '@/collecting/collecting.db';
import { marketplaceProvider } from '@/api/marketplace/marketplace.service';
import { marketChain } from '@/marketplace/market-chain';
import { MEMES_CONTRACT, GRADIENT_CONTRACT } from '@/constants';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import { MarketDiscoveredOrder } from '@/marketplace/provider.types';
import { CollectingCatalog } from '@/collecting/collecting.types';
import {
  discoverCollectListings,
  collectGasReserve,
  rankCollectPurchases
} from './collect-discovery.service';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: {
    getCatalog: jest.fn(),
    rankTdhPurchases: jest.fn().mockResolvedValue({ ranked: [] })
  }
}));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: {
    readAccountHoldings: jest.fn().mockResolvedValue({
      account: { wallets: ['0x00000000000000000000000000000000000000aB'] }
    })
  }
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  marketplaceProvider: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('./collect-plans.service', () => ({
  collectPlanRankingCandidates: jest.fn()
}));

const recipient = '0x00000000000000000000000000000000000000ab';
function order(
  overrides: Partial<MarketDiscoveredOrder> = {}
): MarketDiscoveredOrder {
  return {
    identity: { protocolAddress: 'protocol', orderHash: 'order' },
    maker: '0x00000000000000000000000000000000000000cd',
    recipient,
    asset: { contract: MEMES_CONTRACT, tokenId: '1', standard: 'ERC1155' },
    side: 'LISTING',
    quantity: '2',
    currency: MARKET_ZERO_ADDRESS,
    totalWei: '20',
    unitTotalWei: '10',
    netWei: '20',
    fees: [],
    startTime: String(Math.floor(Date.now() / 1000) - 60),
    endTime: String(Math.floor(Date.now() / 1000) + 600),
    ...overrides
  };
}
function catalog(): CollectingCatalog {
  return {
    version: 'v',
    chain_id: 1,
    seasons: [],
    artists: [],
    pebbles_traits: [],
    tdh_snapshot: null,
    assets: [
      {
        asset_key: 'asset',
        chain_id: 1,
        contract: MEMES_CONTRACT,
        token_id: '1',
        family: 'memes',
        name: 'Artwork',
        image_url: null,
        artist_ids: [],
        season: 1,
        traits: [],
        hodl_rate: 1,
        tdh_eligible: true
      }
    ]
  };
}
function provider(listings: MarketDiscoveredOrder[] = [order()]) {
  const discovery = jest.fn().mockResolvedValue({
    listings,
    next: null,
    coverage: {
      observedAt: new Date().toISOString(),
      receivedCount: listings.length
    }
  });
  jest.mocked(marketplaceProvider).mockReturnValue({
    discoverCollectionListings: discovery
  } as unknown as ReturnType<typeof marketplaceProvider>);
  return discovery;
}
const request = {
  profile_id: 'profile',
  family: 'memes' as const,
  recipient,
  horizon_days: 30 as const
};

describe('collecting listing discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(collectingService.getCatalog).mockResolvedValue(catalog());
    jest.mocked(marketChain).mockReturnValue({
      rpc: {
        getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: BigInt(1) })
      }
    } as unknown as ReturnType<typeof marketChain>);
  });

  it('rejects a family spanning different contracts before calling the provider', async () => {
    const mixed = catalog();
    mixed.assets.push({
      ...mixed.assets[0],
      asset_key: 'other',
      contract: GRADIENT_CONTRACT
    });
    jest.mocked(collectingService.getCatalog).mockResolvedValue(mixed);
    const discover = provider();
    await expect(discoverCollectListings('memes', 24)).rejects.toMatchObject({
      code: 'CATALOG_CHANGED'
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('filters a returned token from the wrong contract even if its token ID exists', async () => {
    provider([
      order({
        asset: { contract: GRADIENT_CONTRACT, tokenId: '1', standard: 'ERC721' }
      })
    ]);
    const result = await discoverCollectListings('memes', 24);
    expect(result.entries).toEqual([]);
    expect(result.received_count).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('excludes checksum-cased self listings, expired orders and future orders from ranking', async () => {
    provider([
      order({ maker: recipient }),
      order({ endTime: String(Math.floor(Date.now() / 1000) - 1) }),
      order({ startTime: String(Math.floor(Date.now() / 1000) + 60) }),
      order({
        identity: { protocolAddress: 'protocol', orderHash: 'eligible' }
      })
    ]);
    await rankCollectPurchases(request);
    const candidates = jest.mocked(collectingService.rankTdhPurchases).mock
      .calls[0][1];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidate_id: 'eligible',
      total_cost_wei: '450010',
      acquisitions: [{ asset_key: 'asset', quantity: '1', recipient }]
    });
    expect(collectingDb.readAccountHoldings).toHaveBeenCalledWith('profile');
  });

  it.each([null, BigInt(0), BigInt(-1)])(
    'fails closed without a positive gas price: %s',
    async (fee) => {
      jest.mocked(marketChain).mockReturnValue({
        rpc: {
          getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: fee })
        }
      } as unknown as ReturnType<typeof marketChain>);
      await expect(collectGasReserve()).rejects.toThrow('gas estimate');
    }
  );

  it('passes an empty observed pool to exact ranking without inventing a candidate', async () => {
    provider([]);
    await rankCollectPurchases(request);
    expect(
      jest.mocked(collectingService.rankTdhPurchases).mock.calls[0][1]
    ).toEqual([]);
  });
  it('skips unrepresentable or malformed candidate expiries without failing valid observed quotes', async () => {
    provider([
      order({ endTime: '8640000000001' }),
      order({ endTime: '9'.repeat(78) }),
      order({ endTime: 'Infinity' }),
      order({ endTime: 'NaN' }),
      order({ identity: { protocolAddress: 'protocol', orderHash: 'valid' } }),
      order({
        endTime: '8640000000000',
        identity: { protocolAddress: 'protocol', orderHash: 'date-boundary' }
      })
    ]);
    await rankCollectPurchases(request);
    const candidates = jest.mocked(collectingService.rankTdhPurchases).mock
      .calls[0][1];
    expect(candidates.map((candidate) => candidate.candidate_id)).toEqual([
      'valid',
      'date-boundary'
    ]);
    expect(
      candidates.every((candidate) =>
        Number.isFinite(Date.parse(candidate.valid_until))
      )
    ).toBe(true);
    expect(candidates[1].valid_until).toBe('+275760-09-13T00:00:00.000Z');
  });
});
