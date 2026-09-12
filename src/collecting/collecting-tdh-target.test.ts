import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { solveCollectingTdhTarget } from '@/collecting/collecting-tdh-target';
import * as tdhProjection from '@/collecting/collecting-tdh-projection';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import {
  CollectingTdhTargetCandidate,
  CollectingTdhTargetRequest
} from '@/collecting/collecting-tdh-target.types';
import {
  CollectingTdhProjectionInput,
  CollectingTdhSource,
  projectCollectingTdh
} from '@/collecting/collecting-tdh-projection';
import { MEMES_CONTRACT, GRADIENT_CONTRACT, NULL_ADDRESS } from '@/constants';
import { Transaction } from '@/entities/ITransaction';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

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
function recompute(
  fixture: CollectingTdhSource,
  result: ReturnType<typeof solveCollectingTdhTarget>,
  recipient = wallet
) {
  const quantities = new Map<string, number>();
  result.selected.forEach(({ candidate: c, quantity }) =>
    quantities.set(c.asset_key, (quantities.get(c.asset_key) ?? 0) + quantity)
  );
  return projectCollectingTdh({
    ...fixture.input,
    evaluated_at: result.projection.evaluated_at,
    transfers: Array.from(quantities, ([asset_key, quantity]) => ({
      contract: asset_key.split(':')[1],
      token_id: Number(asset_key.split(':')[2]),
      quantity,
      from_address: NULL_ADDRESS,
      to_address: recipient,
      timestamp: new Date(now).toISOString()
    }))
  });
}

// Keep pool-cleanup callbacks active while the solver sees a fixed deadline clock.
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => jest.restoreAllMocks());

it('returns the exact best replay at the monotonic limit with response time reserved', () => {
  const fixture = source();
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
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '61' }),
    [candidate(2)],
    now,
    now + 20000,
    budget.child(20000, 2000)
  );
  expect(result).toMatchObject({
    status: 'TARGET_MET_BEST_FOUND',
    purchase_cost_wei: '100',
    signed_fees_wei: '5',
    search: { stop_reason: 'TIME_LIMIT', evaluated_count: 1 }
  });
  expect(result.selected).toEqual([{ candidate: candidate(2), quantity: 1 }]);
  expect(result.projection).toEqual(recompute(fixture, result));
  expect(budget.remainingMs()).toBe(1999);
});

it('does not extend an expired monotonic solver window when the wall clock moves backward', () => {
  const budget = new CollectingWorkBudget(0);
  jest.spyOn(Date, 'now').mockReturnValue(now - 60000);
  expect(() =>
    solveCollectingTdhTarget(source(), request(), [], now, now + 20000, budget)
  ).toThrow('work window');
});

it('uses the future holding-only baseline and spends zero when the total target is already met', () => {
  const fixture = source();
  expect(fixture.official.boosted_tdh).toBeLessThan(50);
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '50' }),
    [candidate(2)],
    now
  );
  expect(result).toMatchObject({
    status: 'NO_PURCHASE_NEEDED',
    purchase_cost_wei: '0',
    signed_fees_wei: '0',
    shortfall_tdh: '0',
    selected: [],
    search: { evaluated_count: 0 }
  });
  expect(result.projection.proposed).toEqual(result.projection.baseline);
});

it('measures additional TDH against the same future baseline and returns exact fee-inclusive costs', () => {
  const fixture = source();
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_mode: 'ADDITIONAL_OVER_BASELINE', target_tdh: '29' }),
    [candidate(2)],
    now
  );
  expect(result.status).toBe('TARGET_MET_BEST_FOUND');
  expect(BigInt(result.target_total_tdh)).toBe(
    BigInt(result.projection.baseline.boosted_tdh) + BigInt(29)
  );
  expect(result.purchase_cost_wei).toBe('100');
  expect(result.signed_fees_wei).toBe('5');
  expect(result.projection).toEqual(recompute(fixture, result));
});

it('evaluates nonlinear completion as a full portfolio instead of adding marginal forecasts', () => {
  const fixture = source();
  fixture.input.seasons = [
    {
      id: 1,
      start_index: 1,
      end_index: 2,
      count: 2,
      boost: 0.05,
      name: 'One',
      display: 'One'
    },
    {
      id: 2,
      start_index: 3,
      end_index: 3,
      count: 1,
      boost: 0.05,
      name: 'Two',
      display: 'Two'
    }
  ];
  fixture.official = projectCollectingTdh(fixture.input).baseline;
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_mode: 'ADDITIONAL_OVER_BASELINE', target_tdh: '63' }),
    [candidate(2), candidate(3)],
    now
  );
  expect(result).toMatchObject({
    status: 'TARGET_MET_BEST_FOUND',
    purchase_cost_wei: '200'
  });
  expect(result.projection.additional_tdh).toBe(63);
  expect(result.projection).toEqual(recompute(fixture, result));
  const two = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '999' }),
    [candidate(2)],
    now
  );
  const three = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '999' }),
    [candidate(3)],
    now
  );
  expect(two.projection.additional_tdh + three.projection.additional_tdh).toBe(
    62
  );
});

it('searches quantities without replaying each edition and never exceeds remaining stock', () => {
  const fixture = source();
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_mode: 'ADDITIONAL_OVER_BASELINE', target_tdh: '2900' }),
    [candidate(2, { available_quantity: 150 })],
    now
  );
  expect(result.status).toBe('TARGET_MET_BEST_FOUND');
  expect(result.selected[0].quantity).toBe(100);
  expect(result.search.evaluated_count).toBeLessThan(32);
  expect(result.projection).toEqual(recompute(fixture, result));
});

it('respects exact whole-lot steps and an optional purchase budget', () => {
  const lot = candidate(2, {
    quantity_step: 2,
    available_quantity: 2,
    step_cost_wei: '200',
    step_fees_wei: '1'
  });
  const result = solveCollectingTdhTarget(
    source(),
    request({ target_tdh: '61' }),
    [lot],
    now
  );
  expect(result.selected[0].quantity).toBe(2);
  expect(result.signed_fees_wei).toBe('1');
  const blocked = solveCollectingTdhTarget(
    source(),
    request({ budget_wei: '199' }),
    [lot],
    now
  );
  expect(blocked.status).toBe('NOT_FOUND_WITHIN_SEARCH');
  expect(blocked.selected).toEqual([]);
  expect(BigInt(blocked.shortfall_tdh)).toBeGreaterThan(BigInt(0));
});

it('never combines overlapping listings by the same maker for the same NFT', () => {
  const result = solveCollectingTdhTarget(
    source(),
    request({ target_tdh: '1000' }),
    [candidate(2), candidate(2, { id: 'alternative' })],
    now
  );
  expect(result.selected).toHaveLength(1);
  expect(result.status).toBe('NOT_FOUND_WITHIN_SEARCH');
});

it('can combine independent makers and aggregates the hypothetical acquisition', () => {
  const fixture = source();
  const result = solveCollectingTdhTarget(
    fixture,
    request(),
    [
      candidate(2),
      candidate(2, {
        id: 'second',
        maker: '0x0000000000000000000000000000000000000033'
      })
    ],
    now
  );
  expect(result.selected).toHaveLength(2);
  expect(result.projection).toEqual(recompute(fixture, result));
});

it('keeps the selected profile wallet in the canonical replay and rejects external recipients', () => {
  const fixture = source();
  const result = solveCollectingTdhTarget(
    fixture,
    request({ recipient: secondWallet }),
    [candidate(2), candidate(3)],
    now
  );
  expect(result.projection).toEqual(recompute(fixture, result, secondWallet));
  expect(() =>
    solveCollectingTdhTarget(fixture, request({ recipient: seller }), [], now)
  ).toThrow('in-profile');
});

it('is deterministic under candidate input permutations', () => {
  const fixture = source();
  expect(
    solveCollectingTdhTarget(
      fixture,
      request(),
      [candidate(2), candidate(3)],
      now
    )
  ).toEqual(
    solveCollectingTdhTarget(
      fixture,
      request(),
      [candidate(3), candidate(2)],
      now
    )
  );
});

it('does not call a captured coverage gap impossible', () => {
  const result = solveCollectingTdhTarget(
    source(),
    request({ target_tdh: '999999' }),
    [],
    now
  );
  expect(result).toMatchObject({
    status: 'NOT_FOUND_WITHIN_SEARCH',
    search: { optimality: 'BEST_FOUND', evaluated_count: 0 }
  });
});

it('requires parity and freshness even for a zero target', () => {
  const fixture = source();
  fixture.official.boosted_tdh++;
  expect(() =>
    solveCollectingTdhTarget(fixture, request({ target_tdh: '0' }), [], now)
  ).toThrow('official snapshot');
  expect(() =>
    solveCollectingTdhTarget(
      source(),
      request({ target_tdh: '0' }),
      [],
      now + 86400001
    )
  ).toThrow('snapshot');
});

it('fails before replay when the request deadline is already exhausted', () => {
  expect(() =>
    solveCollectingTdhTarget(source(), request(), [], now, now)
  ).toThrow('work window');
});

it('rejects unsafe integer targets and malformed trusted quantities', () => {
  expect(() =>
    solveCollectingTdhTarget(
      source(),
      request({ target_tdh: '9007199254740992' }),
      [],
      now
    )
  ).toThrow();
  expect(() =>
    solveCollectingTdhTarget(
      source(),
      request(),
      [candidate(2, { quantity_step: 0 })],
      now
    )
  ).toThrow('candidate');
});

it('does not repurchase a unique NFT already held by any profile wallet', () => {
  const fixture = source();
  fixture.input.tokens.push({
    contract: GRADIENT_CONTRACT,
    token_id: 1,
    family: 'gradients',
    minted_at: '2025-01-01T00:00:00Z',
    hodl_rate: 10
  });
  fixture.input.transactions.push({
    ...fixture.input.transactions[0],
    contract: GRADIENT_CONTRACT,
    to_address: secondWallet
  });
  fixture.official = projectCollectingTdh(fixture.input).baseline;
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '99999' }),
    [candidate(1, { asset_key: collectingAssetKey(GRADIENT_CONTRACT, '1') })],
    now
  );
  expect(result.selected).toEqual([]);
});

it('caps portfolio replay count and never silently splits a completion larger than atomic checkout', () => {
  const fixture = source();
  fixture.input.tokens = Array.from({ length: 130 }, (_, index) => ({
    ...fixture.input.tokens[0],
    token_id: index + 1
  }));
  fixture.official = projectCollectingTdh(fixture.input).baseline;
  const candidates = Array.from({ length: 129 }, (_, index) =>
    candidate(index + 2, { step_cost_wei: '1', step_fees_wei: '0' })
  );
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '999999' }),
    candidates,
    now
  );
  expect(result.status).toBe('NOT_FOUND_WITHIN_SEARCH');
  expect(result.selected.length).toBeLessThanOrEqual(128);
  expect(result.search.evaluated_count).toBeLessThanOrEqual(128);
  expect(result.search.work_used).toBeLessThanOrEqual(10000000);
  expect(['EVALUATION_LIMIT', 'FRONTIER_LIMIT', 'WORK_LIMIT']).toContain(
    result.search.stop_reason
  );
});
it('charges hypothetical multi-edition work and stops before exceeding the replay-work budget', () => {
  const fixture = source();
  fixture.input.tokens = Array.from({ length: 20 }, (_, index) => ({
    ...fixture.input.tokens[0],
    token_id: index + 1
  }));
  fixture.official = projectCollectingTdh(fixture.input).baseline;
  const candidates = Array.from({ length: 19 }, (_, index) =>
    candidate(index + 2, { quantity_step: 9999, available_quantity: 9999 })
  );
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '999999999' }),
    candidates,
    now
  );
  expect(result.search.stop_reason).toBe('WORK_LIMIT');
  expect(result.search.work_used).toBeLessThanOrEqual(10000000);
  expect(result.search.evaluated_count).toBeLessThan(128);
});
it('refuses an oversized candidate universe rather than silently expanding work', () => {
  expect(() =>
    solveCollectingTdhTarget(
      source(),
      request(),
      Array.from({ length: 2001 }, (_, index) =>
        candidate(2, { id: `listing-${index}` })
      ),
      now
    )
  ).toThrow('bounds');
});

it('replays a high-yield unique NFT even when more than 128 cheaper low-yield asks exist', () => {
  const fixture = source();
  fixture.input.tokens = Array.from({ length: 202 }, (_, index) => ({
    ...fixture.input.tokens[0],
    token_id: index + 1
  }));
  fixture.input.tokens.push({
    contract: GRADIENT_CONTRACT,
    token_id: 1,
    family: 'gradients',
    minted_at: '2025-01-01T00:00:00Z',
    hodl_rate: 100
  });
  fixture.official = projectCollectingTdh(fixture.input).baseline;
  const cheap = Array.from({ length: 200 }, (_, index) =>
    candidate(index + 2, { step_cost_wei: '10', step_fees_wei: '0' })
  );
  const efficient = candidate(1, {
    id: 'high-yield-gradient',
    asset_key: collectingAssetKey(GRADIENT_CONTRACT, '1'),
    step_cost_wei: '100',
    step_fees_wei: '0'
  });
  const result = solveCollectingTdhTarget(
    fixture,
    request({ target_tdh: '2000', families: ['memes', 'gradients'] }),
    [...cheap, efficient],
    now
  );
  expect(result.status).toBe('TARGET_MET_BEST_FOUND');
  expect(result.selected.map((item) => item.candidate.id)).toContain(
    'high-yield-gradient'
  );
  expect(result.projection).toEqual(recompute(fixture, result));
});
