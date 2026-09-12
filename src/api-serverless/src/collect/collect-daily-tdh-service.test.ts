import { collectingDb } from '@/collecting/collecting.db';
import { collectingService } from '@/collecting/collecting.service';
import { CollectingDailyTdhRequest } from '@/collecting/collecting-daily-tdh';
import { createCollectingDailyTdhPlanner } from '@/collecting/collecting-daily-tdh';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { collectTdhTargetCandidates } from '@/api/collect/collect-tdh-target-candidates';
import { createCollectDailyTdhPlan } from '@/api/collect/collect-daily-tdh.service';
import { readTargetBooks } from '@/api/collect/collect-tdh-target.service';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readTdhProjectionSource: jest.fn() }
}));
jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/collecting/collecting-daily-tdh', () => ({
  createCollectingDailyTdhPlanner: jest.fn()
}));
jest.mock('@/api/collect/collect-tdh-target-candidates', () => ({
  collectTdhTargetCandidates: jest.fn()
}));
jest.mock('@/api/collect/collect-tdh-target.service', () => ({
  readTargetBooks: jest.fn()
}));

const wallet = '0x0000000000000000000000000000000000000011';
const recipient = '0x0000000000000000000000000000000000000012';
const seller = '0x0000000000000000000000000000000000000022';
const contract = '0x0000000000000000000000000000000000000033';
const assetKey = `1:${contract}:1`;
const candidate = {
  id: `${MARKET_SEAPORT}:0x${'1'.repeat(64)}`,
  asset_key: assetKey,
  maker: seller,
  quantity_step: 1,
  available_quantity: 1,
  step_cost_wei: '100',
  step_fees_wei: '5'
};
const asset = {
  asset_key: assetKey,
  chain_id: 1,
  contract,
  token_id: '1',
  family: 'memes' as const,
  name: 'Meme',
  image_url: null,
  artist_ids: [],
  season: 1,
  traits: [],
  hodl_rate: 1,
  tdh_eligible: true
};
const listing = {
  candidate,
  asset,
  valid_until: '2026-01-31T13:00:00.000Z',
  order: {
    identity: {
      protocolAddress: MARKET_SEAPORT,
      orderHash: `0x${'1'.repeat(64)}`
    },
    maker: seller,
    recipient: seller,
    asset: { contract, tokenId: '1', standard: 'ERC1155' as const },
    side: 'LISTING' as const,
    quantity: '1',
    availableQuantity: '1',
    unitTotalWei: '100',
    currency: MARKET_ZERO_ADDRESS,
    totalWei: '100',
    netWei: '95',
    fees: [{ recipient: seller, amountWei: '5' }],
    startTime: '1769857200',
    endTime: '1769864400'
  }
};

const completeCoverage = {
  indexed_ask_count: 1,
  evaluated_ask_count: 1,
  candidate_count: 1,
  excluded_ask_count: 0,
  index_complete: true,
  market_complete: false as const,
  observed_at: '2026-01-31T12:00:00.000Z'
};

const personalEffects = {
  counts_toward_profile: true,
  baseline_base_tdh_per_day_hundredths: '200',
  proposed_base_tdh_per_day_hundredths: '300',
  baseline_boost: 1,
  proposed_boost: 1.05,
  baseline_boosted_tdh_per_day_ten_thousandths: '20000',
  proposed_boosted_tdh_per_day_ten_thousandths: '31500',
  additional_boosted_tdh_per_day_ten_thousandths: '11500',
  changed_boost_on_existing_tdh: 10
};

function request(
  extra: Partial<CollectingDailyTdhRequest> = {}
): CollectingDailyTdhRequest {
  return {
    profile_id: 'profile',
    recipient: wallet,
    families: ['memes'],
    mode: 'BASE_TDH_TARGET',
    target_base_tdh_per_day_hundredths: '100',
    ...extra
  };
}

function planResult(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    selected: [],
    base_tdh_per_day_hundredths: '0',
    purchase_cost_wei: '0',
    signed_fees_wei: '0',
    search: {
      evaluated_portfolios: 0,
      candidate_count: 0,
      stop_reason: 'COMPLETE',
      optimality: 'BEST_FOUND'
    },
    snapshot_block: 100,
    snapshot_timestamp: '2026-01-31T00:00:00.000Z',
    acquisition_timestamp: '2026-01-31T12:00:00.000Z',
    rules_version: 'rules',
    personal_effects: personalEffects,
    ...extra
  };
}

let elapsed = 0;
let project: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  elapsed = 0;
  jest
    .mocked(collectingDb.readTdhProjectionSource)
    .mockResolvedValue({ source: true } as never);
  jest.mocked(collectingService.getCatalog).mockResolvedValue({
    version: 'catalog',
    assets: [asset]
  } as never);
  jest
    .mocked(readTargetBooks)
    .mockResolvedValue([{ family: 'memes', books: [] }]);
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [],
    coverage: { ...completeCoverage, candidate_count: 0 }
  });
  project = jest.fn().mockReturnValue(planResult());
  jest.mocked(createCollectingDailyTdhPlanner).mockReturnValue(project);
});

function workBudget(): CollectingWorkBudget {
  return new CollectingWorkBudget(20000, () => elapsed);
}

it('distinguishes an incomplete timed-out capture from confirmed no listings', async () => {
  jest.mocked(readTargetBooks).mockImplementation(async () => {
    elapsed = 8001;
    return [];
  });
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [],
    coverage: {
      ...completeCoverage,
      candidate_count: 0,
      index_complete: false
    }
  });

  const partial = await createCollectDailyTdhPlan(request(), workBudget());
  expect(partial).toMatchObject({
    status: 'PARTIAL',
    coverage: { index_complete: false },
    search: { stop_reason: 'TIME_LIMIT' }
  });

  elapsed = 0;
  jest
    .mocked(readTargetBooks)
    .mockResolvedValue([{ family: 'memes', books: [] }]);
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [],
    coverage: { ...completeCoverage, candidate_count: 0 }
  });
  const complete = await createCollectDailyTdhPlan(request(), workBudget());
  expect(complete).toMatchObject({
    status: 'NO_LISTINGS',
    coverage: { index_complete: true },
    search: { stop_reason: 'COMPLETE' }
  });
});

it('keeps a met target authoritative when coverage is incomplete', async () => {
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [listing],
    coverage: { ...completeCoverage, index_complete: false }
  });
  project.mockReturnValue(
    planResult({
      selected: [{ candidate, quantity: 1 }],
      base_tdh_per_day_hundredths: '100',
      purchase_cost_wei: '100',
      signed_fees_wei: '5',
      search: {
        evaluated_portfolios: 1,
        candidate_count: 1,
        stop_reason: 'COMPLETE',
        optimality: 'BEST_FOUND'
      }
    })
  );

  const result = await createCollectDailyTdhPlan(request(), workBudget());
  expect(result.status).toBe('TARGET_MET_BEST_FOUND');
  expect(result.coverage.index_complete).toBe(false);
});

it('does not read market books for a zero objective', async () => {
  const result = await createCollectDailyTdhPlan(
    request({ target_base_tdh_per_day_hundredths: '0' }),
    workBudget()
  );

  expect(readTargetBooks).not.toHaveBeenCalled();
  expect(collectTdhTargetCandidates).toHaveBeenCalledWith(
    expect.anything(),
    [asset],
    [],
    expect.any(Number),
    expect.any(Number),
    expect.any(CollectingWorkBudget)
  );
  expect(result).toMatchObject({
    status: 'NO_PURCHASE_NEEDED',
    items: [],
    purchase_cost_wei: '0',
    gas_estimate_wei: '0',
    funding_estimate_wei: '0'
  });
});

it('preserves included fees and leaves gas unknown for a selected listing', async () => {
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [listing],
    coverage: completeCoverage
  });
  project.mockReturnValue(
    planResult({
      selected: [{ candidate, quantity: 1 }],
      base_tdh_per_day_hundredths: '100',
      purchase_cost_wei: '100',
      signed_fees_wei: '5',
      search: {
        evaluated_portfolios: 1,
        candidate_count: 1,
        stop_reason: 'COMPLETE',
        optimality: 'BEST_FOUND'
      }
    })
  );

  const result = await createCollectDailyTdhPlan(request(), workBudget());
  expect(result).toMatchObject({
    purchase_cost_wei: '100',
    signed_fees_wei: '5',
    gas_estimate_wei: null,
    funding_estimate_wei: null,
    items: [
      {
        quantity: '1',
        recipient: wallet,
        order: { total_wei: '100', fees: [{ amount_wei: '5' }] }
      }
    ]
  });
});

it('propagates external-recipient personal effects and item delivery', async () => {
  jest.mocked(collectTdhTargetCandidates).mockReturnValue({
    listings: [listing],
    coverage: { ...completeCoverage, index_complete: false }
  });
  const externalEffects = {
    ...personalEffects,
    counts_toward_profile: false,
    proposed_base_tdh_per_day_hundredths:
      personalEffects.baseline_base_tdh_per_day_hundredths,
    proposed_boost: personalEffects.baseline_boost,
    proposed_boosted_tdh_per_day_ten_thousandths:
      personalEffects.baseline_boosted_tdh_per_day_ten_thousandths,
    additional_boosted_tdh_per_day_ten_thousandths: '0',
    changed_boost_on_existing_tdh: 0
  };
  project.mockReturnValue(
    planResult({
      selected: [{ candidate, quantity: 1 }],
      base_tdh_per_day_hundredths: '100',
      purchase_cost_wei: '100',
      signed_fees_wei: '5',
      personal_effects: externalEffects,
      search: {
        evaluated_portfolios: 1,
        candidate_count: 1,
        stop_reason: 'COMPLETE',
        optimality: 'BEST_FOUND'
      }
    })
  );

  const result = await createCollectDailyTdhPlan(
    request({
      recipient,
      mode: 'ETH_BUDGET',
      target_base_tdh_per_day_hundredths: undefined,
      budget_wei: '250'
    }),
    workBudget()
  );
  expect(result).toMatchObject({
    status: 'BUDGET_ALLOCATED_BEST_FOUND',
    remaining_budget_wei: '150',
    coverage: { index_complete: false }
  });
  expect(result.personal_effects).toEqual(externalEffects);
  expect(result.items[0].recipient).toBe(recipient);
});
