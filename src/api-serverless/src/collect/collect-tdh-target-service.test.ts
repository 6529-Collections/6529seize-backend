import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  CollectingTdhProjectionInput,
  CollectingTdhSource,
  projectCollectingTdh
} from '@/collecting/collecting-tdh-projection';
import {
  CollectingTdhTargetCandidate,
  CollectingTdhTargetRequest
} from '@/collecting/collecting-tdh-target.types';
import { MEMES_CONTRACT } from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import { collectingDb } from '@/collecting/collecting.db';
import { collectingService } from '@/collecting/collecting.service';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { collectTdhTargetCandidates } from '@/api/collect/collect-tdh-target-candidates';
import {
  createCollectTdhTargetPlan,
  readTargetBooks
} from '@/api/collect/collect-tdh-target.service';
import * as targetSolver from '@/collecting/collecting-tdh-target';
import * as tdhProjection from '@/collecting/collecting-tdh-projection';
import {
  CollectingWorkBudget,
  CollectingWorkTimeout
} from '@/collecting/collecting-work-budget';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readTdhProjectionSource: jest.fn() }
}));
jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/api/market-depth/market-depth-api.db', () => ({
  marketDepthApiDb: { getBooks: jest.fn().mockResolvedValue([]) }
}));
jest.mock('@/api/collect/collect-tdh-target-candidates', () => ({
  collectTdhTargetCandidates: jest.fn()
}));

const wallet = '0x0000000000000000000000000000000000000011';
const secondWallet = '0x0000000000000000000000000000000000000012';
const seller = '0x0000000000000000000000000000000000000022';
const now = Date.parse('2026-01-31T12:00:00Z');
const key = (id: number) => collectingAssetKey(MEMES_CONTRACT, String(id));
function source(): CollectingTdhSource {
  const tx: Transaction = {
    transaction: 'history',
    block: 1,
    created_at: new Date('2026-01-01T00:00:00Z'),
    transaction_date: new Date('2026-01-01T00:00:00Z'),
    contract: MEMES_CONTRACT,
    token_id: 1,
    token_count: 1,
    from_address: seller,
    to_address: wallet,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
  const input: CollectingTdhProjectionInput = {
    snapshot_block: 100,
    snapshot_timestamp: '2026-01-31T00:00:00Z',
    evaluated_at: '2026-01-31T00:00:00Z',
    rules_version: 'fixture',
    wallets: [wallet, secondWallet],
    tokens: [1, 2, 3].map((token_id) => ({
      contract: MEMES_CONTRACT,
      token_id,
      family: 'memes',
      minted_at: '2025-01-01T00:00:00Z',
      hodl_rate: 1,
      calculation_edition_size: 100
    })),
    seasons: [],
    transactions: [tx],
    transfers: []
  };
  return {
    account: {
      profile_id: 'profile',
      consolidation_key: wallet,
      wallets: input.wallets,
      membership_hash: 'membership'
    },
    input,
    official: projectCollectingTdh(input).baseline
  };
}
function request(
  extra: Partial<CollectingTdhTargetRequest> = {}
): CollectingTdhTargetRequest {
  return {
    profile_id: 'profile',
    recipient: wallet,
    target_mode: 'TOTAL_AT_DEADLINE',
    target_tdh: '100',
    horizon_days: 30,
    families: ['memes'],
    ...extra
  };
}
function candidate(
  id: number,
  extra: Partial<CollectingTdhTargetCandidate> = {}
): CollectingTdhTargetCandidate {
  return {
    id: `order-${id}`,
    asset_key: key(id),
    maker: seller,
    quantity_step: 1,
    available_quantity: 1,
    step_cost_wei: '100',
    step_fees_wei: '5',
    ...extra
  };
}

function listing(c = candidate(2)) {
  const asset = {
    asset_key: c.asset_key,
    chain_id: 1,
    contract: MEMES_CONTRACT.toLowerCase(),
    token_id: '2',
    family: 'memes' as const,
    name: 'Meme 2',
    image_url: null,
    artist_ids: [],
    season: 1,
    traits: [],
    hodl_rate: 1,
    tdh_eligible: true
  };
  return {
    candidate: c,
    asset,
    valid_until: '2026-01-31T13:00:00.000Z',
    order: {
      identity: {
        protocolAddress: MARKET_SEAPORT,
        orderHash: '0x' + '1'.repeat(64)
      },
      maker: c.maker,
      recipient: c.maker,
      asset: {
        contract: MEMES_CONTRACT.toLowerCase(),
        tokenId: '2',
        standard: 'ERC1155' as const
      },
      side: 'LISTING' as const,
      quantity: String(c.quantity_step),
      availableQuantity: String(c.available_quantity),
      unitTotalWei: c.step_cost_wei,
      currency: MARKET_ZERO_ADDRESS,
      totalWei: c.step_cost_wei,
      netWei: (BigInt(c.step_cost_wei) - BigInt(c.step_fees_wei)).toString(),
      fees: [{ recipient: seller, amountWei: c.step_fees_wei }],
      startTime: String(now / 1000 - 3600),
      endTime: String(now / 1000 + 3600)
    }
  };
}
const coverage = {
  indexed_ask_count: 1,
  evaluated_ask_count: 1,
  candidate_count: 1,
  excluded_ask_count: 0,
  index_complete: true,
  market_complete: false,
  observed_at: new Date(now).toISOString()
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(collectingDb.readTdhProjectionSource).mockResolvedValue(source());
  jest.mocked(collectingService.getCatalog).mockResolvedValue({
    version: 'catalog',
    chain_id: 1,
    assets: [listing().asset],
    seasons: [],
    artists: [],
    pebbles_traits: [],
    tdh_snapshot: null
  });
  jest
    .mocked(collectTdhTargetCandidates)
    .mockReturnValue({ listings: [listing()], coverage });
});
afterEach(() => jest.restoreAllMocks());

it('keeps an actual timed-out books read expired and incomplete with real monotonic timers', async () => {
  const budget = new CollectingWorkBudget(5.8);
  jest
    .mocked(marketDepthApiDb.getBooks)
    .mockImplementationOnce(() => new Promise(() => {}));
  const groups = await readTargetBooks([listing().asset], ['memes'], budget);
  expect(groups).toEqual([]);
  expect(budget.expired()).toBe(true);
  const realCapture = jest.requireActual<
    typeof import('@/api/collect/collect-tdh-target-candidates')
  >('@/api/collect/collect-tdh-target-candidates').collectTdhTargetCandidates;
  const captured = realCapture(
    source(),
    [listing().asset],
    groups,
    now,
    now + 1000,
    budget
  );
  expect(captured.coverage.index_complete).toBe(false);
  expect(captured.listings).toEqual([]);
});

it('bounds a stalled source read with real timers before starting projection work', async () => {
  const solver = jest.spyOn(targetSolver, 'createCollectingTdhTargetSolver');
  const fixture = source();
  let finish: (value: CollectingTdhSource) => void = () => {};
  jest.mocked(collectingDb.readTdhProjectionSource).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await expect(
    createCollectTdhTargetPlan(request(), new CollectingWorkBudget(2010))
  ).rejects.toBeInstanceOf(CollectingWorkTimeout);
  finish(fixture);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(solver).not.toHaveBeenCalled();
  expect(collectTdhTargetCandidates).not.toHaveBeenCalled();
  expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
});

it.each(['source', 'catalog'] as const)(
  'does not start projection or market parsing after a late %s read',
  async (kind) => {
    let elapsed = 0;
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (kind === 'source') {
      jest
        .mocked(collectingDb.readTdhProjectionSource)
        .mockImplementationOnce(async () => {
          await pending;
          return source();
        });
    } else {
      jest
        .mocked(collectingService.getCatalog)
        .mockImplementationOnce(async () => {
          await pending;
          return {
            version: 'late',
            chain_id: 1,
            assets: [],
            seasons: [],
            artists: [],
            pebbles_traits: [],
            tdh_snapshot: null
          };
        });
    }
    const solver = jest.spyOn(targetSolver, 'createCollectingTdhTargetSolver');
    const result = createCollectTdhTargetPlan(
      request(),
      new CollectingWorkBudget(20000, () => elapsed)
    );
    await Promise.resolve();
    elapsed = 18001;
    finish();
    await expect(result).rejects.toBeInstanceOf(CollectingWorkTimeout);
    expect(solver).not.toHaveBeenCalled();
    expect(collectTdhTargetCandidates).not.toHaveBeenCalled();
    expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
  }
);

it('keeps a verified baseline and honest TIME_LIMIT coverage when market I/O returns too late', async () => {
  let elapsed = 0;
  jest.mocked(marketDepthApiDb.getBooks).mockImplementationOnce(async () => {
    elapsed = 8001;
    return [];
  });
  jest
    .mocked(collectTdhTargetCandidates)
    .mockImplementationOnce((_source, _assets, groups) => {
      expect(groups).toEqual([]);
      return {
        listings: [],
        coverage: {
          ...coverage,
          indexed_ask_count: 0,
          evaluated_ask_count: 0,
          candidate_count: 0,
          index_complete: false
        }
      };
    });
  const result = await createCollectTdhTargetPlan(
    request(),
    new CollectingWorkBudget(20000, () => elapsed)
  );
  expect(result).toMatchObject({
    status: 'NOT_FOUND_WITHIN_SEARCH',
    items: [],
    purchase_cost_wei: '0',
    gas_estimate_wei: null,
    funding_estimate_wei: null,
    coverage: { index_complete: false, market_complete: false },
    search: { stop_reason: 'TIME_LIMIT', evaluated_count: 0 }
  });
  expect(result.projection.proposed).toEqual(result.projection.baseline);
  expect(BigInt(result.shortfall_tdh)).toBeGreaterThan(BigInt(0));
});

it('shares source-read elapsed time with capture and solver instead of restarting either window', async () => {
  let elapsed = 0;
  jest
    .mocked(collectingDb.readTdhProjectionSource)
    .mockImplementationOnce(async () => {
      elapsed = 11000;
      return source();
    });
  jest.mocked(marketDepthApiDb.getBooks).mockImplementationOnce(async () => {
    elapsed = 17000;
    return [];
  });
  jest.mocked(collectTdhTargetCandidates).mockImplementationOnce(() => {
    elapsed = 18001;
    return {
      listings: [listing()],
      coverage: { ...coverage, index_complete: false }
    };
  });
  const result = await createCollectTdhTargetPlan(
    request(),
    new CollectingWorkBudget(20000, () => elapsed)
  );
  expect(result).toMatchObject({
    status: 'NOT_FOUND_WITHIN_SEARCH',
    items: [],
    purchase_cost_wei: '0',
    search: { stop_reason: 'TIME_LIMIT', evaluated_count: 0 }
  });
  expect(result.projection.acquisition_timestamp).toBe(
    new Date(now).toISOString()
  );
});

it('returns an exact best-found portfolio at the search limit before the request budget expires', async () => {
  let elapsed = 0;
  const budget = new CollectingWorkBudget(20000, () => elapsed);
  const createProjector = tdhProjection.createCollectingTdhProjector;
  jest
    .spyOn(tdhProjection, 'createCollectingTdhProjector')
    .mockImplementation((input) => {
      const project = createProjector(input);
      return (transfers) => {
        const result = project(transfers);
        if (transfers.length) elapsed = 18001;
        return result;
      };
    });
  const result = await createCollectTdhTargetPlan(
    request({ target_tdh: '61' }),
    budget
  );
  expect(result).toMatchObject({
    status: 'TARGET_MET_BEST_FOUND',
    purchase_cost_wei: '100',
    signed_fees_wei: '5',
    gas_estimate_wei: null,
    funding_estimate_wei: null,
    search: { stop_reason: 'TIME_LIMIT', evaluated_count: 1 }
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ recipient: wallet, quantity: '1' });
  expect(budget.remainingMs()).toBe(1999);
});

it('returns a profile-bound exact listing portfolio and leaves gas unquoted', async () => {
  const result = await createCollectTdhTargetPlan(
    request({ target_tdh: '61' })
  );
  expect(result).toMatchObject({
    status: 'TARGET_MET_BEST_FOUND',
    purchase_cost_wei: '100',
    signed_fees_wei: '5',
    gas_estimate_wei: null,
    funding_estimate_wei: null,
    target_total_tdh: '61',
    shortfall_tdh: '0',
    catalog_version: 'catalog',
    valid_until: '2026-01-31T13:00:00.000Z'
  });
  expect(result.plan_id).toHaveLength(64);
  expect(result.request).toEqual(request({ target_tdh: '61' }));
  expect(result.items[0]).toMatchObject({
    quantity: '1',
    recipient: wallet,
    order: { quantity: '1', available_quantity: '1', total_wei: '100' }
  });
  expect(result.projection.account).toEqual(source().account);
  expect(result.projection.recipient_allocations).toEqual([
    {
      asset_key: key(2),
      quantity: '1',
      recipient: wallet,
      counts_toward_profile: true
    }
  ]);
  expect(Array.isArray(result.projection.proposed.boost_breakdown)).toBe(true);
});
it('returns zero funding without reading market books when future holding already meets the target', async () => {
  const result = await createCollectTdhTargetPlan(
    request({ target_tdh: '50' })
  );
  expect(result).toMatchObject({
    status: 'NO_PURCHASE_NEEDED',
    purchase_cost_wei: '0',
    signed_fees_wei: '0',
    gas_estimate_wei: '0',
    funding_estimate_wei: '0',
    items: [],
    valid_until: null
  });
  expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
  expect(result.projection.recipient_allocations).toEqual([]);
});
it('keeps a budget-constrained gap honest instead of reporting zero funding as sufficient', async () => {
  const result = await createCollectTdhTargetPlan(request({ budget_wei: '0' }));
  expect(result).toMatchObject({
    status: 'NOT_FOUND_WITHIN_SEARCH',
    purchase_cost_wei: '0',
    gas_estimate_wei: null,
    funding_estimate_wei: null,
    items: []
  });
  expect(BigInt(result.shortfall_tdh)).toBeGreaterThan(BigInt(0));
});
it('aggregates same-asset projection allocations while retaining individual pinned order items', async () => {
  const first = listing(),
    second = listing(
      candidate(2, {
        id: 'other-order',
        maker: '0x0000000000000000000000000000000000000033'
      })
    );
  second.order.identity.orderHash = '0x' + '2'.repeat(64);
  jest
    .mocked(collectTdhTargetCandidates)
    .mockReturnValue({ coverage, listings: [first, second] });
  const result = await createCollectTdhTargetPlan(request());
  expect(result.items).toHaveLength(2);
  expect(result.projection.recipient_allocations).toEqual([
    {
      asset_key: key(2),
      quantity: '2',
      recipient: wallet,
      counts_toward_profile: true
    }
  ]);
  expect(result.purchase_cost_wei).toBe('200');
  expect(result.signed_fees_wei).toBe('10');
});
it('rejects an external recipient or parity mismatch before market reads', async () => {
  await expect(
    createCollectTdhTargetPlan(request({ recipient: seller }))
  ).rejects.toThrow('in-profile');
  const changed = source();
  changed.official.boosted_tdh++;
  jest.mocked(collectingDb.readTdhProjectionSource).mockResolvedValue(changed);
  await expect(createCollectTdhTargetPlan(request())).rejects.toThrow(
    'official snapshot'
  );
  expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
});
