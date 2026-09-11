import { CollectingAnalysis } from '@/collecting/collecting.types';
import {
  collectPlanView,
  advanceCollectPlan,
  collectPlanRankingCandidates
} from './collect-plans.service';
import { collectingService } from '@/collecting/collecting.service';
import { dbSupplier } from '@/sql-executor';
import { marketplaceProvider } from '@/api/marketplace/marketplace.service';
import * as planner from '@/collecting/collecting-planner';
import { MEMES_CONTRACT } from '@/constants';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { analyze: jest.fn(), getCatalog: jest.fn() }
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  marketplaceProvider: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));
jest.mock('@/marketplace/provider.opensea', () => ({
  ...jest.requireActual('@/marketplace/provider.opensea'),
  describeMarketOrder: jest.fn(() => ({ totalWei: '1' }))
}));

const analysis: CollectingAnalysis = {
  analysis_id: 'a',
  catalog_version: 'v',
  account: {
    profile_id: 'p',
    consolidation_key: 'w',
    wallets: ['w'],
    membership_hash: 'h'
  },
  holdings_snapshot: { block_number: 1, nextgen_block_number: 1 },
  kind: 'exact',
  target_copies: '1',
  requirements: [
    {
      id: 'r',
      label: 'Artwork',
      target_quantity: '1',
      owned_quantity: '0',
      missing_quantity: '1',
      asset_keys: ['asset'],
      holdings: []
    }
  ],
  required_count: 1,
  satisfied_count: 0,
  complete: false,
  missing_asset_keys: ['asset'],
  recipient: 'w',
  recipient_in_profile: true,
  counts_toward_profile: true
};
function row(cursor = 0) {
  return {
    id: 'plan',
    profile_id: 'p',
    state: 'SCANNING' as 'SCANNING' | 'READY' | 'STALE',
    lease_token: null as string | null,
    lease_until: 0,
    updated_at: 1,
    payload_json: JSON.stringify({
      goal: { profile_id: 'p', kind: 'exact' },
      analysis,
      budget_wei: '100',
      asset_keys: ['asset'],
      cursor,
      candidates: [],
      unavailable: 0,
      failed: 0,
      gas_reserve_per_order_wei: '1'
    })
  };
}

const catalogAsset = {
  asset_key: 'asset',
  chain_id: 1,
  contract: MEMES_CONTRACT,
  token_id: '1',
  family: 'memes' as const,
  name: 'Artwork',
  image_url: null,
  artist_ids: [],
  season: null,
  traits: [],
  hodl_rate: 1,
  tdh_eligible: true
};

function mockCatalog(assets = [catalogAsset]) {
  jest.mocked(collectingService.getCatalog).mockResolvedValue({
    version: 'v',
    chain_id: 1,
    assets,
    artists: [],
    seasons: [],
    pebbles_traits: [],
    tdh_snapshot: null
  });
}

function scanFixture(current = analysis) {
  const saved = row();
  saved.payload_json = JSON.stringify({
    ...JSON.parse(saved.payload_json),
    analysis: current
  });
  const listing = {
    identity: { protocolAddress: 'protocol', orderHash: 'order' },
    maker: '0x00000000000000000000000000000000000000ab',
    currency: MARKET_ZERO_ADDRESS,
    quantity: '1',
    endTime: String(Math.floor(Date.now() / 1000) + 600)
  };
  const provider = {
    discoverOrders: jest.fn().mockResolvedValue([listing]),
    getOrder: jest.fn().mockResolvedValue({ components: { orderType: 1 } })
  };
  jest
    .mocked(marketplaceProvider)
    .mockReturnValue(
      provider as unknown as ReturnType<typeof marketplaceProvider>
    );
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes('SET lease_token=:lease')) {
        saved.lease_token = String(params.lease);
        saved.lease_until = Number(params.until);
      }
      if (sql.includes('SET payload_json')) {
        saved.payload_json = String(params.payload);
        saved.state = params.state as typeof saved.state;
        saved.lease_token = null;
        saved.lease_until = 0;
      }
      return [{ affected: 1 }];
    }
  );
  jest.mocked(dbSupplier).mockReturnValue({
    oneOrNull: jest.fn().mockImplementation(() => Promise.resolve(saved)),
    execute,
    getAffectedRows: (rows: Array<{ affected: number }>) => rows[0].affected
  } as unknown as ReturnType<typeof dbSupplier>);
  jest.mocked(collectingService.analyze).mockResolvedValue(current);
  mockCatalog();
  return { saved, listing, provider, execute };
}

describe('persisted collecting scans', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('checkpoints a final pair without exceeding the persisted candidate bound', async () => {
    const current = {
      ...analysis,
      required_count: 2,
      missing_asset_keys: ['asset', 'other'],
      requirements: [
        ...analysis.requirements,
        { ...analysis.requirements[0], id: 'other', asset_keys: ['other'] }
      ]
    };
    const { saved, provider, listing } = scanFixture(current);
    const payload = JSON.parse(saved.payload_json);
    payload.asset_keys = ['asset', 'other'];
    payload.candidates = Array.from({ length: 1999 }, (_, index) => ({
      candidate_id: `old-${index}`,
      order_id: `old-${index}`,
      asset_key: 'asset',
      quantity_available: '1',
      unit_price_wei: '1',
      execution_group: `old-${index}`,
      group_cost_wei: '1',
      inventory_key: `old-${index}`,
      inventory_quantity: '1',
      valid_until: new Date(Date.now() + 600000).toISOString()
    }));
    saved.payload_json = JSON.stringify(payload);
    mockCatalog([
      catalogAsset,
      { ...catalogAsset, asset_key: 'other', token_id: '2' }
    ]);
    provider.discoverOrders.mockImplementation(
      async (asset: { tokenId: string }) => [
        {
          ...listing,
          identity: { ...listing.identity, orderHash: asset.tokenId }
        }
      ]
    );
    const result = await advanceCollectPlan('plan', 'p');
    expect(result.checked_asset_count).toBe(2);
    expect(JSON.parse(saved.payload_json).candidates).toHaveLength(2000);
    expect(result.candidate_universe_complete).toBe(false);
  });

  it('excludes a self-listing when a persisted profile wallet is checksum-cased', async () => {
    const { provider } = scanFixture({
      ...analysis,
      account: {
        ...analysis.account,
        wallets: ['0x00000000000000000000000000000000000000aB']
      }
    });
    const result = await advanceCollectPlan('plan', 'p');
    expect(provider.getOrder).not.toHaveBeenCalled();
    expect(result.checked_asset_count).toBe(1);
    expect(result.result.legs).toHaveLength(0);
  });

  it('awaits a slow discovery, then checkpoints the failed asset without starting another request outside its budget', async () => {
    const started = Date.now();
    let now = started;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { provider, listing } = scanFixture();
    provider.discoverOrders.mockImplementation(async () => {
      now += 13000;
      return [listing];
    });
    const result = await advanceCollectPlan('plan', 'p');
    expect(provider.getOrder).not.toHaveBeenCalled();
    expect(result.checked_asset_count).toBe(1);
    expect(result.failed_asset_count).toBe(1);
    expect(result.asset_scan_complete).toBe(false);
  });

  it('bounds order reads to the one requested best listing even if a provider returns extras', async () => {
    const { provider, listing } = scanFixture();
    provider.discoverOrders.mockResolvedValue([
      listing,
      {
        ...listing,
        identity: { protocolAddress: 'protocol', orderHash: 'extra' }
      }
    ]);
    const result = await advanceCollectPlan('plan', 'p');
    expect(provider.getOrder).toHaveBeenCalledTimes(1);
    expect(result.result.legs[0].unit_price_wei).toBe('1');
  });

  it('preserves a completed checkpoint after expiry when no newer worker took ownership', async () => {
    const { saved, execute } = scanFixture();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (sql, params) => {
      if (sql.includes('SET payload_json')) {
        saved.lease_until = Number(params.now) - 1;
        expect(saved.lease_token).toBe(params.lease);
        expect(sql).not.toContain('lease_until>:now');
      }
      return original(sql, params);
    });
    const result = await advanceCollectPlan('plan', 'p');
    expect(result.checked_asset_count).toBe(1);
    expect(result.result.legs).toHaveLength(1);
  });

  it('returns a retry conflict when final checkpoint ownership was lost after successful renewal', async () => {
    const { saved, execute } = scanFixture();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (sql, params) => {
      if (sql.includes('SET payload_json')) {
        saved.lease_token = 'newer-worker';
        return [{ affected: 0 }];
      }
      return original(sql, params);
    });
    await expect(advanceCollectPlan('plan', 'p')).rejects.toMatchObject({
      code: 'PLAN_SCAN_RETRY'
    });
    expect(JSON.parse(saved.payload_json).cursor).toBe(0);
    expect(saved.lease_token).toBe('newer-worker');
  });

  it('requires refresh if a generated basket references a missing saved quote', async () => {
    const { saved } = scanFixture();
    saved.state = 'READY';
    const result = planner.planCollectingAcquisitions(analysis, [], {
      evaluated_at: new Date().toISOString()
    });
    jest.spyOn(planner, 'planCollectingAcquisitions').mockReturnValue({
      ...result,
      legs: [
        {
          candidate_id: 'missing',
          order_id: 'order',
          asset_key: 'asset',
          quantity: '1'
        }
      ]
    });
    await expect(
      collectPlanRankingCandidates('plan', 'p', 'w')
    ).rejects.toMatchObject({ code: 'HOLDINGS_CHANGED' });
  });

  it('omits after-snapshot or otherwise ineligible artworks without projecting a partial basket as complete', async () => {
    const candidates = ['asset', 'new-release'].map((asset_key, index) => ({
      candidate_id: `candidate-${index}`,
      order_id: `order-${index}`,
      asset_key,
      quantity_available: '1',
      unit_price_wei: '1',
      execution_group: `group-${index}`,
      group_cost_wei: '1',
      inventory_key: `inventory-${index}`,
      inventory_quantity: '1',
      valid_until: new Date(Date.now() + 60000).toISOString()
    }));
    const current = {
      ...analysis,
      requirements: [
        analysis.requirements[0],
        {
          ...analysis.requirements[0],
          id: 'new-release',
          asset_keys: ['new-release']
        }
      ],
      required_count: 2,
      missing_asset_keys: ['asset', 'new-release']
    };
    const saved = {
      ...row(2),
      state: 'READY',
      payload_json: JSON.stringify({
        goal: { profile_id: 'p', kind: 'exact' },
        analysis: current,
        budget_wei: '100',
        asset_keys: ['asset', 'new-release'],
        cursor: 2,
        candidates,
        unavailable: 0,
        failed: 0,
        gas_reserve_per_order_wei: '1'
      })
    };
    jest.mocked(dbSupplier).mockReturnValue({
      oneOrNull: jest.fn().mockResolvedValue(saved)
    } as unknown as ReturnType<typeof dbSupplier>);
    jest.mocked(collectingService.analyze).mockResolvedValue(current);
    const asset = {
      asset_key: 'asset',
      chain_id: 1,
      contract: 'contract',
      token_id: '1',
      family: 'memes' as const,
      name: 'Artwork',
      image_url: null,
      artist_ids: [],
      season: null,
      traits: [],
      hodl_rate: 1,
      tdh_eligible: true
    };
    const catalog = {
      version: 'v',
      chain_id: 1,
      assets: [
        asset,
        { ...asset, asset_key: 'new-release', tdh_eligible: false }
      ],
      artists: [],
      seasons: [],
      pebbles_traits: [],
      tdh_snapshot: null
    };
    jest.mocked(collectingService.getCatalog).mockResolvedValue(catalog);
    const ranked = await collectPlanRankingCandidates('plan', 'p', 'w');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].candidate_id).toBe('candidate-0');
    expect(ranked[0].acquisitions).toEqual([
      { asset_key: 'asset', quantity: '1', recipient: 'w' }
    ]);
    jest
      .mocked(collectingService.getCatalog)
      .mockResolvedValue({ ...catalog, assets: [] });
    expect(await collectPlanRankingCandidates('plan', 'p', 'w')).toEqual([]);
  });
  it('distinguishes a completed asset scan from incomplete market coverage', () => {
    const view = collectPlanView({ ...row(1), state: 'READY' });
    expect(view.asset_scan_complete).toBe(true);
    expect(view.candidate_universe_complete).toBe(false);
    expect(view.result.status).toBe('unavailable');
  });
  it('uses the checkpoint loaded after acquisition instead of a stale pre-lock snapshot', async () => {
    const before = row(0),
      after = row(1);
    const oneOrNull = jest
      .fn()
      .mockResolvedValueOnce(before)
      .mockImplementation(() => Promise.resolve(after));
    const execute = jest.fn(
      async (sql: string, params: Record<string, unknown>) => {
        if (sql.includes('SET lease_token=:lease'))
          after.lease_token = String(params.lease);
        return [];
      }
    );
    jest.mocked(dbSupplier).mockReturnValue({
      oneOrNull,
      execute,
      getAffectedRows: () => 1
    } as unknown as ReturnType<typeof dbSupplier>);
    jest.mocked(collectingService.analyze).mockResolvedValue(analysis);
    await advanceCollectPlan('plan', 'p');
    expect(collectingService.getCatalog).not.toHaveBeenCalled();
    const update = execute.mock.calls.find(([sql]) =>
      sql.includes('SET payload_json')
    );
    expect(JSON.parse(String(update?.[1].payload)).cursor).toBe(1);
  });
  it('does not persist a batch after losing its lease', async () => {
    const saved = row();
    const execute = jest.fn(
      async (sql: string, params: Record<string, unknown>) => {
        if (sql.includes('SET lease_token=:lease'))
          saved.lease_token = String(params.lease);
        return [];
      }
    );
    const affected = jest.fn().mockReturnValueOnce(1).mockReturnValue(0);
    jest.mocked(dbSupplier).mockReturnValue({
      oneOrNull: jest.fn().mockImplementation(() => Promise.resolve(saved)),
      execute,
      getAffectedRows: affected
    } as unknown as ReturnType<typeof dbSupplier>);
    jest.mocked(collectingService.analyze).mockResolvedValue(analysis);
    await expect(advanceCollectPlan('plan', 'p')).rejects.toMatchObject({
      code: 'PLAN_SCAN_RETRY'
    });
    expect(
      execute.mock.calls.some(([sql]) => sql.includes('SET payload_json'))
    ).toBe(false);
    expect(collectingService.getCatalog).not.toHaveBeenCalled();
  });
  it('invalidates membership changes before fetching listings', async () => {
    const saved = row();
    const execute = jest.fn(
      async (sql: string, params: Record<string, unknown>) => {
        if (sql.includes('SET lease_token=:lease'))
          saved.lease_token = String(params.lease);
        return [];
      }
    );
    jest.mocked(dbSupplier).mockReturnValue({
      oneOrNull: jest.fn().mockImplementation(() => Promise.resolve(saved)),
      execute,
      getAffectedRows: () => 1
    } as unknown as ReturnType<typeof dbSupplier>);
    jest.mocked(collectingService.analyze).mockResolvedValue({
      ...analysis,
      account: { ...analysis.account, membership_hash: 'changed' }
    });
    await advanceCollectPlan('plan', 'p');
    expect(
      execute.mock.calls.some(([sql]) => sql.includes("state='STALE'"))
    ).toBe(true);
    expect(collectingService.getCatalog).not.toHaveBeenCalled();
  });
});
