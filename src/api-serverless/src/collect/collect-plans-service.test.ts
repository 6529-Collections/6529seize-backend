import { CollectingAnalysis } from '@/collecting/collecting.types';
import {
  collectPlanView,
  advanceCollectPlan,
  collectPlanRankingCandidates,
  createCollectPlan,
  collectPlanOptionsSchema,
  readCollectPlan
} from './collect-plans.service';
import { collectingService } from '@/collecting/collecting.service';
import { dbSupplier } from '@/sql-executor';
import { marketplaceProvider } from '@/api/marketplace/marketplace.service';
import * as planner from '@/collecting/collecting-planner';
import { MEMES_CONTRACT } from '@/constants';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { marketChain } from '@/marketplace/market-chain';
import {
  CollectingWorkBudget,
  CollectingWorkTimeout
} from '@/collecting/collecting-work-budget';
import {
  CollectIndexedPlanSeed,
  seedCollectPlanFromIndex
} from '@/api/collect/collect-indexed-plan-seed';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { analyze: jest.fn(), getCatalog: jest.fn() }
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  marketplaceProvider: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));
jest.mock('@/api/collect/collect-indexed-plan-seed', () => ({
  seedCollectPlanFromIndex: jest.fn()
}));
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
      if (sql.includes("SET state='STALE'")) {
        saved.state = 'STALE';
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

function holdPlanReplica(
  primary: ReturnType<typeof row>,
  replica: ReturnType<typeof row> | null = { ...primary }
) {
  const db = dbSupplier();
  // Writes continue updating primary; the replica never catches up during the test.
  const oneOrNull = jest.fn(
    async (
      _sql: string,
      params: Record<string, unknown>,
      options?: DbQueryOptions
    ) => {
      const selected =
        options?.forcePool === DbPoolName.WRITE ? primary : replica;
      if (
        !selected ||
        selected.id !== params.id ||
        selected.profile_id !== params.profileId
      )
        return null;
      return { ...selected };
    }
  );
  jest.mocked(dbSupplier).mockReturnValue({
    ...db,
    oneOrNull
  } as unknown as ReturnType<typeof dbSupplier>);
}

function reorderJsonProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderJsonProperties);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reorderJsonProperties(item)])
    );
  return value;
}

function createFixture(current = analysis) {
  const fixture = scanFixture(current);
  const original = fixture.execute.getMockImplementation()!;
  fixture.execute.mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT INTO collect_plans')) {
      Object.assign(fixture.saved, params);
      return [{ affected: 1 }];
    }
    return original(sql, params);
  });
  holdPlanReplica(fixture.saved, null);
  const getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: BigInt(1) });
  jest.mocked(marketChain).mockReturnValue({
    rpc: { getFeeData }
  } as unknown as ReturnType<typeof marketChain>);
  return { ...fixture, getFeeData };
}

function indexedSeed(assetKeys = ['asset']): CollectIndexedPlanSeed {
  return {
    candidates: assetKeys.map((asset_key) => ({
      candidate_id: `candidate-${asset_key}`,
      order_id: `order-${asset_key}`,
      asset_key,
      quantity_available: '1',
      unit_price_wei: '100',
      execution_group: `group-${asset_key}`,
      group_cost_wei: '450000',
      inventory_key: `seller:${asset_key}`,
      inventory_quantity: '1',
      valid_until: new Date(Date.now() + 60000).toISOString()
    })),
    checked_asset_count: assetKeys.length,
    unavailable_asset_count: 0,
    indexed_ask_count: assetKeys.length,
    source_snapshot_ids: ['complete-snapshot'],
    observed_at: new Date().toISOString(),
    source: 'OPENSEA_COMPLETE_INDEX'
  };
}

describe('persisted collecting scans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(seedCollectPlanFromIndex).mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, '1000000'])(
    'persists budget %s and immediately reads the plan before its row reaches the replica',
    async (budget) => {
      const { saved, execute } = scanFixture();
      const original = execute.getMockImplementation()!;
      execute.mockImplementation(async (sql, params) => {
        if (sql.startsWith('INSERT INTO collect_plans')) {
          Object.assign(saved, params);
          return [{ affected: 1 }];
        }
        return original(sql, params);
      });
      holdPlanReplica(saved, null);
      jest.mocked(marketChain).mockReturnValue({
        rpc: {
          getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: BigInt(1) })
        }
      } as unknown as ReturnType<typeof marketChain>);

      const created = await createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        {
          recipient: 'w',
          ...(budget === undefined ? {} : { budget_wei: budget })
        }
      );
      expect(created).toMatchObject({
        id: saved.id,
        profile_id: 'p',
        state: 'SCANNING',
        checked_asset_count: 0,
        total_asset_count: 1
      });
      await expect(readCollectPlan(created.id, 'p')).resolves.toMatchObject({
        id: created.id,
        analysis
      });
      const payload = JSON.parse(saved.payload_json);
      expect('budget_wei' in payload).toBe(budget !== undefined);
      expect(payload.budget_wei).toBe(budget);
    }
  );

  it('distinguishes uncapped analysis from an explicit zero spending cap', async () => {
    const { saved } = scanFixture();
    const payload = JSON.parse(saved.payload_json);
    delete payload.budget_wei;
    saved.payload_json = JSON.stringify(payload);
    const uncapped = await advanceCollectPlan('plan', 'p');
    expect(uncapped.result.legs).toHaveLength(1);
    const cappedPayload = JSON.parse(saved.payload_json);
    cappedPayload.budget_wei = '0';
    saved.payload_json = JSON.stringify(cappedPayload);
    const capped = await readCollectPlan('plan', 'p');
    expect(capped.result.legs).toHaveLength(0);
    expect(capped.result.total_cost_wei).toBe('0');
    expect(capped.budget_wei).toBe('0');
    expect(capped.available_result.legs).toEqual(uncapped.result.legs);
    expect(capped.available_result.total_cost_wei).toBe(
      uncapped.result.total_cost_wei
    );
  });

  it('compares full captured availability and an exact budget using identical orders, quantities, prices and gas', () => {
    const saved = row(2);
    const candidates = indexedSeed(['asset', 'second']).candidates;
    candidates[0] = {
      ...candidates[0],
      quantity_available: '2',
      inventory_quantity: '2',
      group_cost_wei: '5'
    };
    candidates[1] = {
      ...candidates[1],
      unit_price_wei: '300',
      group_cost_wei: '7'
    };
    const goal = {
      ...analysis,
      requirements: [
        {
          ...analysis.requirements[0],
          target_quantity: '2',
          missing_quantity: '2'
        },
        {
          ...analysis.requirements[0],
          id: 'second-requirement',
          asset_keys: ['second']
        }
      ],
      required_count: 2,
      missing_asset_keys: ['asset', 'second']
    };
    saved.payload_json = JSON.stringify({
      ...JSON.parse(saved.payload_json),
      analysis: goal,
      asset_keys: ['asset', 'second'],
      candidates,
      budget_wei: '205'
    });
    const optimize = jest.spyOn(planner, 'planCollectingAcquisitions');

    const view = collectPlanView(saved);

    expect(view.budget_wei).toBe('205');
    expect(view.result.status).toBe('partial');
    expect(view.result.total_cost_wei).toBe('205');
    expect(view.result.legs).toEqual([
      {
        candidate_id: 'candidate-asset',
        order_id: 'order-asset',
        asset_key: 'asset',
        quantity: '2',
        unit_price_wei: '100'
      }
    ]);
    expect(view.available_result.status).toBe('complete');
    expect(view.available_result.total_cost_wei).toBe('512');
    expect(view.available_result.legs).toEqual([
      ...view.result.legs,
      {
        candidate_id: 'candidate-second',
        order_id: 'order-second',
        asset_key: 'second',
        quantity: '1',
        unit_price_wei: '300'
      }
    ]);
    expect(view.available_result.evaluated_at).toBe(view.result.evaluated_at);
    expect(view.candidate_universe_complete).toBe(false);
    expect(optimize).toHaveBeenCalledTimes(2);
    const [capped, available] = optimize.mock.calls;
    expect(available[0]).toBe(capped[0]);
    expect(available[1]).toBe(capped[1]);
    expect(capped[2]).toEqual({
      evaluated_at: view.result.evaluated_at,
      max_states: 20000,
      budget_wei: '205'
    });
    expect(available[2]).toEqual({
      evaluated_at: view.result.evaluated_at,
      max_states: 20000
    });
  });

  it('reuses the uncapped result with no budget field or second optimization', () => {
    const saved = row(1);
    const payload = JSON.parse(saved.payload_json);
    delete payload.budget_wei;
    payload.candidates = indexedSeed().candidates;
    saved.payload_json = JSON.stringify(payload);
    const optimize = jest.spyOn(planner, 'planCollectingAcquisitions');

    const view = collectPlanView(saved);

    expect(view).not.toHaveProperty('budget_wei');
    expect(view.available_result).toBe(view.result);
    expect(view.result.legs[0]).toMatchObject({
      order_id: 'order-asset',
      unit_price_wei: '100'
    });
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it('uses one expiry boundary for both results and removes expired captured orders from each', () => {
    const saved = row(1);
    const candidates = indexedSeed().candidates;
    const at = new Date(Date.now() + 1000).toISOString();
    candidates[0].valid_until = at;
    saved.payload_json = JSON.stringify({
      ...JSON.parse(saved.payload_json),
      candidates,
      budget_wei: '1000000'
    });
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(at);

    const view = collectPlanView(saved);

    expect(view.result.evaluated_at).toBe(at);
    expect(view.available_result.evaluated_at).toBe(at);
    expect(view.result.legs).toEqual([]);
    expect(view.available_result.legs).toEqual([]);
    expect(view.result.candidate_count).toBe(0);
    expect(view.available_result.candidate_count).toBe(0);
  });

  it.each([undefined, '0', '1000000'])(
    'creates a ready indexed estimate with budget %s and preserves source, recipient and gas',
    async (budget) => {
      const current = {
        ...analysis,
        recipient: 'friend',
        recipient_in_profile: false,
        counts_toward_profile: false
      };
      const { saved, provider, execute } = createFixture(current);
      const seed = indexedSeed();
      jest.mocked(seedCollectPlanFromIndex).mockResolvedValue(seed);
      const created = await createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        {
          recipient: 'friend',
          ...(budget === undefined ? {} : { budget_wei: budget })
        }
      );
      expect(collectingService.analyze).toHaveBeenCalledWith({
        profile_id: 'p',
        kind: 'exact',
        recipient: 'friend'
      });
      expect(seedCollectPlanFromIndex).toHaveBeenCalledTimes(1);
      expect(seedCollectPlanFromIndex).toHaveBeenCalledWith(
        {
          analysis: current,
          assetKeys: ['asset'],
          gasReservePerOrderWei: '450000'
        },
        expect.any(CollectingWorkBudget)
      );
      expect(created).toMatchObject({
        state: 'READY',
        checked_asset_count: 1,
        total_asset_count: 1,
        failed_asset_count: 0,
        asset_scan_complete: true,
        candidate_universe_complete: false,
        gas_reserve_per_order_wei: '450000',
        analysis: current
      });
      expect(created.result.legs).toHaveLength(budget === '0' ? 0 : 1);
      expect(created.result.total_cost_wei).toBe(
        budget === '0' ? '0' : '450100'
      );
      expect(created.available_result.total_cost_wei).toBe('450100');
      expect(created.available_result.legs).toHaveLength(1);
      expect(created.available_result.evaluated_at).toBe(
        created.result.evaluated_at
      );
      expect('budget_wei' in created).toBe(budget !== undefined);
      expect(created.budget_wei).toBe(budget);
      expect(created.assumptions[0]).toContain(seed.observed_at);
      const payload = JSON.parse(saved.payload_json);
      expect('budget_wei' in payload).toBe(budget !== undefined);
      expect(payload.indexed_source).toEqual({
        source: seed.source,
        observed_at: seed.observed_at,
        indexed_ask_count: seed.indexed_ask_count,
        source_snapshot_ids: seed.source_snapshot_ids
      });
      execute.mockClear();
      await expect(advanceCollectPlan(saved.id, 'p')).resolves.toMatchObject({
        state: 'READY',
        checked_asset_count: 1
      });
      expect(execute).not.toHaveBeenCalled();
      expect(provider.discoverOrders).not.toHaveBeenCalled();
      expect(provider.getOrder).not.toHaveBeenCalled();
    }
  );

  it('accounts for all 546 missing NFTs at creation without per-NFT provider calls', async () => {
    const keys = Array.from({ length: 546 }, (_, index) => `asset-${index}`);
    const current = {
      ...analysis,
      required_count: keys.length,
      missing_asset_keys: keys,
      requirements: keys.map((key) => ({
        ...analysis.requirements[0],
        id: key,
        asset_keys: [key]
      }))
    };
    const { provider } = createFixture(current);
    const seed = indexedSeed(keys);
    seed.candidates.pop();
    seed.unavailable_asset_count = 1;
    jest.mocked(seedCollectPlanFromIndex).mockResolvedValue(seed);
    const created = await createCollectPlan(
      'p',
      { profile_id: 'p', kind: 'memes_full_set' },
      { recipient: 'w' }
    );
    expect(created).toMatchObject({
      state: 'READY',
      checked_asset_count: 546,
      total_asset_count: 546,
      unavailable_asset_count: 1,
      asset_scan_complete: true,
      candidate_universe_complete: false
    });
    expect(seedCollectPlanFromIndex).toHaveBeenCalledTimes(1);
    expect(created.result.legs).toHaveLength(545);
    expect(provider.discoverOrders).not.toHaveBeenCalled();
    expect(provider.getOrder).not.toHaveBeenCalled();
  });

  it('accounts for a complete empty index without reporting provider failures', async () => {
    createFixture();
    const seed = indexedSeed();
    seed.candidates = [];
    seed.indexed_ask_count = 0;
    seed.unavailable_asset_count = 1;
    jest.mocked(seedCollectPlanFromIndex).mockResolvedValue(seed);
    await expect(
      createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        { recipient: 'w' }
      )
    ).resolves.toMatchObject({
      state: 'READY',
      unavailable_asset_count: 1,
      failed_asset_count: 0,
      asset_scan_complete: true,
      result: { status: 'unavailable', legs: [] }
    });
  });

  it('keeps the provider scanner when complete indexed coverage is unavailable', async () => {
    const { saved, provider } = createFixture();
    const created = await createCollectPlan(
      'p',
      { profile_id: 'p', kind: 'exact' },
      { recipient: 'w' }
    );
    expect(created.state).toBe('SCANNING');
    expect(JSON.parse(saved.payload_json)).not.toHaveProperty('indexed_source');
    await expect(advanceCollectPlan(saved.id, 'p')).resolves.toMatchObject({
      state: 'READY',
      checked_asset_count: 1
    });
    expect(provider.discoverOrders).toHaveBeenCalledTimes(1);
    expect(provider.getOrder).toHaveBeenCalledTimes(1);
  });

  it('reserves persistence time and saves no partial scan progress after the seed budget is exhausted', async () => {
    const { saved } = createFixture();
    let elapsed = 0;
    jest
      .mocked(seedCollectPlanFromIndex)
      .mockImplementation(async (_options, budget) => {
        expect(budget!.remainingMs()).toBe(8000);
        elapsed = 8000;
        return null;
      });
    const created = await createCollectPlan(
      'p',
      { profile_id: 'p', kind: 'exact' },
      { recipient: 'w' },
      new CollectingWorkBudget(11000, () => elapsed)
    );
    expect(created).toMatchObject({
      state: 'SCANNING',
      checked_asset_count: 0,
      unavailable_asset_count: 0,
      failed_asset_count: 0
    });
    expect(JSON.parse(saved.payload_json)).toMatchObject({
      cursor: 0,
      candidates: [],
      unavailable: 0
    });
  });

  it('does not insert a late plan after a source read consumed the request deadline', async () => {
    const { execute } = createFixture();
    let elapsed = 0;
    jest.mocked(collectingService.analyze).mockImplementation(async () => {
      elapsed = 21;
      return analysis;
    });
    await expect(
      createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        { recipient: 'w' },
        new CollectingWorkBudget(20, () => elapsed)
      )
    ).rejects.toBeInstanceOf(CollectingWorkTimeout);
    expect(execute).not.toHaveBeenCalled();
    expect(seedCollectPlanFromIndex).not.toHaveBeenCalled();
  });

  it('does not read the index for an already complete goal', async () => {
    createFixture({
      ...analysis,
      complete: true,
      satisfied_count: 1,
      missing_asset_keys: [],
      requirements: [
        {
          ...analysis.requirements[0],
          owned_quantity: '1',
          missing_quantity: '0'
        }
      ]
    });
    await expect(
      createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        { recipient: 'w' }
      )
    ).resolves.toMatchObject({ state: 'READY', total_asset_count: 0 });
    expect(seedCollectPlanFromIndex).not.toHaveBeenCalled();
  });

  it('requires the active profile, matching analysis and live gas before reading the index', async () => {
    const { getFeeData } = createFixture();
    await expect(
      createCollectPlan(
        'other',
        { profile_id: 'p', kind: 'exact' },
        { recipient: 'w' }
      )
    ).rejects.toMatchObject({
      message: 'Create a plan for your active profile.'
    });
    await expect(
      createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        {
          recipient: 'w',
          expected_analysis_id: 'old-analysis'
        }
      )
    ).rejects.toMatchObject({ code: 'HOLDINGS_CHANGED' });
    getFeeData.mockResolvedValue({ maxFeePerGas: null });
    await expect(
      createCollectPlan(
        'p',
        { profile_id: 'p', kind: 'exact' },
        { recipient: 'w' }
      )
    ).rejects.toMatchObject({ message: 'A gas estimate is unavailable.' });
    expect(seedCollectPlanFromIndex).not.toHaveBeenCalled();
  });

  it('drops expired indexed candidates and still rejects changed profile or recipient state', async () => {
    const { saved } = createFixture();
    const seed = indexedSeed();
    jest.mocked(seedCollectPlanFromIndex).mockResolvedValue(seed);
    await createCollectPlan(
      'p',
      { profile_id: 'p', kind: 'exact' },
      { recipient: 'w' }
    );
    const payload = JSON.parse(saved.payload_json);
    payload.candidates[0].valid_until = new Date(Date.now() - 1).toISOString();
    saved.payload_json = JSON.stringify(reorderJsonProperties(payload));
    await expect(readCollectPlan(saved.id, 'p')).resolves.toMatchObject({
      result: { legs: [] }
    });
    jest.mocked(collectingService.analyze).mockResolvedValue({
      ...analysis,
      recipient: 'changed-recipient',
      account: { ...analysis.account, membership_hash: 'changed' }
    });
    await expect(
      collectPlanRankingCandidates(saved.id, 'p', 'w')
    ).rejects.toMatchObject({
      code: 'HOLDINGS_CHANGED'
    });
  });

  it.each(['', '-1', '1.5', '1e3', ' 1', null, 1, '9'.repeat(79)])(
    'rejects an invalid supplied analysis cap %s',
    (budget_wei) => {
      expect(
        collectPlanOptionsSchema.safeParse({
          recipient: MEMES_CONTRACT,
          budget_wei
        }).success
      ).toBe(false);
    }
  );

  it('accepts omitted or exact integer analysis caps', () => {
    for (const options of [{}, { budget_wei: '0' }, { budget_wei: '100' }]) {
      expect(
        collectPlanOptionsSchema.safeParse({
          recipient: MEMES_CONTRACT,
          ...options
        }).success
      ).toBe(true);
    }
  });

  it('observes its acquired lease and returns the new checkpoint while the replica retains the previous scan', async () => {
    const { saved, provider } = scanFixture();
    holdPlanReplica(saved);

    const result = await advanceCollectPlan('plan', 'p');

    expect(provider.discoverOrders).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: 'READY',
      checked_asset_count: 1,
      asset_scan_complete: true
    });
    expect(result.result.legs).toHaveLength(1);
    await expect(readCollectPlan('plan', 'p')).resolves.toMatchObject({
      state: 'READY',
      checked_asset_count: 1
    });
    await expect(
      collectPlanRankingCandidates('plan', 'p', 'w')
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acquisitions: [{ asset_key: 'asset', quantity: '1', recipient: 'w' }]
        })
      ])
    );
    await advanceCollectPlan('plan', 'p');
    expect(provider.discoverOrders).toHaveBeenCalledTimes(1);
    expect(saved.lease_token).toBeNull();
  });

  it('returns a membership-invalidated plan even while the replica still has a scanning row', async () => {
    const { saved, execute, provider } = scanFixture();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (sql, params) => {
      if (sql.includes("SET state='STALE'")) {
        saved.state = 'STALE';
        saved.lease_token = null;
        saved.lease_until = 0;
      }
      return original(sql, params);
    });
    holdPlanReplica(saved);
    jest.mocked(collectingService.analyze).mockResolvedValue({
      ...analysis,
      account: { ...analysis.account, membership_hash: 'changed' }
    });

    await expect(advanceCollectPlan('plan', 'p')).resolves.toMatchObject({
      state: 'STALE'
    });
    expect(provider.discoverOrders).not.toHaveBeenCalled();
    expect(saved.lease_token).toBeNull();
  });

  it('scans and ranks unchanged holdings after JSON storage reorders nested object properties', async () => {
    const withHolding: CollectingAnalysis = {
      ...analysis,
      requirements: analysis.requirements.map((requirement) => ({
        ...requirement,
        target_quantity: '2',
        owned_quantity: '1',
        holdings: [{ asset_key: 'asset', wallet: 'w', quantity: '1' }]
      }))
    };
    const { saved, provider } = scanFixture(withHolding);
    saved.payload_json = JSON.stringify(
      reorderJsonProperties(JSON.parse(saved.payload_json))
    );
    holdPlanReplica(saved);

    const advanced = await advanceCollectPlan('plan', 'p');
    expect(advanced).toMatchObject({ state: 'READY', checked_asset_count: 1 });
    expect(provider.discoverOrders).toHaveBeenCalledTimes(1);

    saved.payload_json = JSON.stringify(
      reorderJsonProperties(JSON.parse(saved.payload_json))
    );
    await expect(
      collectPlanRankingCandidates('plan', 'p', 'w')
    ).resolves.toHaveLength(2);
  });

  it.each<[string, (current: CollectingAnalysis) => CollectingAnalysis]>([
    ['recipient', (current) => ({ ...current, recipient: 'other-wallet' })],
    [
      'additional account state',
      (current) => {
        const extended = {
          ...current,
          account: { ...current.account, membership_revision: 2 }
        };
        return extended;
      }
    ],
    [
      'owned quantity',
      (current) => ({
        ...current,
        requirements: current.requirements.map((requirement) => ({
          ...requirement,
          owned_quantity: '1',
          missing_quantity: '0',
          holdings: [{ asset_key: 'asset', wallet: 'w', quantity: '1' }]
        }))
      })
    ],
    [
      'required asset',
      (current) => ({
        ...current,
        requirements: current.requirements.map((requirement) => ({
          ...requirement,
          asset_keys: ['different-asset']
        }))
      })
    ]
  ])(
    'still invalidates a stored plan when its %s changes',
    async (_name, change) => {
      const { saved, provider } = scanFixture();
      saved.payload_json = JSON.stringify(
        reorderJsonProperties(JSON.parse(saved.payload_json))
      );
      jest
        .mocked(collectingService.analyze)
        .mockResolvedValue(change(analysis));

      await expect(advanceCollectPlan('plan', 'p')).resolves.toMatchObject({
        state: 'STALE',
        checked_asset_count: 0
      });
      expect(provider.discoverOrders).not.toHaveBeenCalled();
      await expect(
        collectPlanRankingCandidates('plan', 'p', 'w')
      ).rejects.toMatchObject({
        message:
          'Finish or refresh the collecting plan before comparing its TDH.'
      });
    }
  );

  it.each<[string, () => Promise<unknown>]>([
    ['read', () => readCollectPlan('plan', 'other-profile')],
    ['advance', () => advanceCollectPlan('plan', 'other-profile')],
    ['rank', () => collectPlanRankingCandidates('plan', 'other-profile', 'w')]
  ])(
    "does not %s another profile's plan from the primary",
    async (_name, work) => {
      const { saved, execute, provider } = scanFixture();
      holdPlanReplica(saved, null);

      await expect(work()).rejects.toMatchObject({
        message: 'Collecting plan not found.'
      });
      expect(execute).not.toHaveBeenCalled();
      expect(collectingService.analyze).not.toHaveBeenCalled();
      expect(provider.discoverOrders).not.toHaveBeenCalled();
    }
  );

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
