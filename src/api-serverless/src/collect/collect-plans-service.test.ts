import { CollectingAnalysis } from '@/collecting/collecting.types';
import {
  collectPlanView,
  advanceCollectPlan,
  collectPlanRankingCandidates
} from './collect-plans.service';
import { collectingService } from '@/collecting/collecting.service';
import { dbSupplier } from '@/sql-executor';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { analyze: jest.fn(), getCatalog: jest.fn() }
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  marketplaceProvider: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));

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
    state: 'SCANNING' as const,
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

describe('persisted collecting scans', () => {
  beforeEach(() => jest.clearAllMocks());

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
    await advanceCollectPlan('plan', 'p');
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
