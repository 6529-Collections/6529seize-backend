import {
  CollectingDailyTdhCandidate,
  solveCollectingDailyTdhSearch
} from '@/collecting/collecting-daily-tdh-search';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';

const UINT256_MAX = ((BigInt(1) << BigInt(256)) - BigInt(1)).toString();

function candidate(
  id: string,
  extra: Partial<CollectingDailyTdhCandidate> = {}
): CollectingDailyTdhCandidate {
  return {
    id,
    asset_key: `asset:${id}`,
    maker: `maker:${id}`,
    quantity_step: 1,
    available_quantity: 1,
    step_cost_wei: '100',
    step_fees_wei: '10',
    rate_hundredths: '100',
    unique: true,
    ...extra
  };
}

function solveTarget(
  candidates: CollectingDailyTdhCandidate[],
  target: string,
  budget = new CollectingWorkBudget(20000)
) {
  return solveCollectingDailyTdhSearch(
    candidates,
    {
      mode: 'BASE_TDH_TARGET',
      target_base_tdh_per_day_hundredths: target
    },
    budget
  );
}

function solveBudget(
  candidates: CollectingDailyTdhCandidate[],
  budgetWei: string,
  budget = new CollectingWorkBudget(20000)
) {
  return solveCollectingDailyTdhSearch(
    candidates,
    { mode: 'ETH_BUDGET', budget_wei: budgetWei },
    budget
  );
}

it('maximizes exact base TDH within budget and leaves unusable dust', () => {
  const result = solveBudget(
    [
      candidate('efficient', {
        unique: false,
        available_quantity: 4,
        step_cost_wei: '30',
        step_fees_wei: '3',
        rate_hundredths: '50'
      }),
      candidate('less-efficient', {
        step_cost_wei: '21',
        step_fees_wei: '2',
        rate_hundredths: '20'
      })
    ],
    '100'
  );
  expect(result).toMatchObject({
    base_tdh_per_day_hundredths: '150',
    purchase_cost_wei: '90',
    signed_fees_wei: '9',
    search: { optimality: 'BEST_FOUND', candidate_count: 2 }
  });
  expect(result.selected).toEqual([
    {
      candidate: expect.objectContaining({ id: 'efficient' }),
      quantity: 3
    }
  ]);
});

it('rounds target quantities up to the signed lot step', () => {
  const result = solveTarget(
    [
      candidate('lot', {
        unique: false,
        quantity_step: 2,
        available_quantity: 6,
        step_cost_wei: '50',
        step_fees_wei: '4',
        rate_hundredths: '3'
      })
    ],
    '10'
  );
  expect(result).toMatchObject({
    base_tdh_per_day_hundredths: '12',
    purchase_cost_wei: '100',
    signed_fees_wei: '8'
  });
  expect(result.selected[0].quantity).toBe(4);
});

it('uses first-candidate alternatives to avoid a discrete greedy overshoot', () => {
  const result = solveTarget(
    [
      candidate('a', {
        unique: false,
        available_quantity: 2,
        step_cost_wei: '50',
        rate_hundredths: '70'
      }),
      candidate('b', {
        step_cost_wei: '31',
        rate_hundredths: '40'
      })
    ],
    '100'
  );
  expect(result).toMatchObject({
    base_tdh_per_day_hundredths: '110',
    purchase_cost_wei: '81'
  });
  expect(result.selected.map(({ candidate: item }) => item.id)).toEqual([
    'a',
    'b'
  ]);
});

it('never combines alternative orders backed by the same maker inventory', () => {
  const shared = { asset_key: 'asset:shared', maker: '0xABC', unique: false };
  const result = solveBudget(
    [
      candidate('first', {
        ...shared,
        step_cost_wei: '1',
        step_fees_wei: '0'
      }),
      candidate('second', {
        ...shared,
        maker: '0xabc',
        step_cost_wei: '1',
        step_fees_wei: '0',
        rate_hundredths: '90'
      })
    ],
    '2'
  );
  expect(result.selected).toHaveLength(1);
  expect(result.base_tdh_per_day_hundredths).toBe('100');
});

it('selects at most one unique token across different sellers', () => {
  const result = solveBudget(
    [
      candidate('first', {
        asset_key: 'asset:unique',
        step_cost_wei: '1',
        step_fees_wei: '0'
      }),
      candidate('second', {
        asset_key: 'asset:unique',
        maker: 'other-maker',
        step_cost_wei: '1',
        step_fees_wei: '0',
        rate_hundredths: '90'
      })
    ],
    '2'
  );
  expect(result.selected).toHaveLength(1);
  expect(result.base_tdh_per_day_hundredths).toBe('100');
});

it('combines multi-copy inventory from different sellers within the asset cap', () => {
  const shared = { asset_key: 'asset:edition', unique: false };
  const result = solveBudget(
    [
      candidate('first', {
        ...shared,
        available_quantity: 3,
        step_cost_wei: '2',
        step_fees_wei: '0',
        rate_hundredths: '7'
      }),
      candidate('second', {
        ...shared,
        available_quantity: 2,
        step_cost_wei: '2',
        step_fees_wei: '0',
        rate_hundredths: '7'
      })
    ],
    '10'
  );
  expect(result.selected.map(({ quantity }) => quantity)).toEqual([3, 2]);
  expect(result.base_tdh_per_day_hundredths).toBe('35');
});

it('returns an empty complete result for zero goals, budgets, and usable rates', () => {
  expect(solveTarget([candidate('one')], '0').selected).toEqual([]);
  expect(solveBudget([candidate('one')], '0').selected).toEqual([]);
  expect(
    solveTarget([candidate('zero', { rate_hundredths: '0' })], '10')
  ).toMatchObject({
    selected: [],
    base_tdh_per_day_hundredths: '0',
    search: { candidate_count: 0, stop_reason: 'COMPLETE' }
  });
});

it('caps a portfolio before uint256 cost overflow', () => {
  const result = solveTarget(
    [
      candidate('expensive', {
        unique: false,
        available_quantity: 2,
        step_cost_wei: UINT256_MAX,
        step_fees_wei: '0',
        rate_hundredths: '1'
      })
    ],
    '2'
  );
  expect(result).toMatchObject({
    base_tdh_per_day_hundredths: '1',
    purchase_cost_wei: UINT256_MAX
  });
  expect(result.selected[0].quantity).toBe(1);
});

it('reports a monotonic timeout without returning a partial portfolio', () => {
  let clock = 0;
  const result = solveTarget(
    [candidate('one'), candidate('two')],
    '200',
    new CollectingWorkBudget(5, () => clock++)
  );
  expect(result).toMatchObject({
    selected: [],
    search: { evaluated_portfolios: 0, stop_reason: 'TIME_LIMIT' }
  });
});

it('bounds the search to 128 portfolios and 2,000 candidates', () => {
  const candidates = Array.from({ length: 200 }, (_, index) =>
    candidate(String(index).padStart(3, '0'), {
      step_cost_wei: '1',
      step_fees_wei: '0',
      rate_hundredths: '1'
    })
  );
  const result = solveBudget(candidates, '1000');
  expect(result.search).toMatchObject({
    evaluated_portfolios: 128,
    candidate_count: 200,
    stop_reason: 'EVALUATION_LIMIT'
  });
  expect(result.selected).toHaveLength(128);
  expect(() =>
    solveBudget(
      Array.from({ length: 2001 }, (_, index) => candidate(String(index))),
      '1'
    )
  ).toThrow('candidate bounds');
});

it('rejects noncanonical and structurally unsafe trusted inputs', () => {
  expect(() => solveTarget([candidate('one')], '01')).toThrow(
    'daily TDH target'
  );
  expect(() =>
    solveBudget([candidate('one', { step_cost_wei: '0' })], '1')
  ).toThrow('candidate');
  expect(() =>
    solveTarget(
      [
        candidate('one', {
          quantity_step: 2,
          available_quantity: 2,
          unique: true
        })
      ],
      '1'
    )
  ).toThrow('candidate');
  expect(() =>
    solveCollectingDailyTdhSearch(
      [candidate('one')],
      {
        mode: 'ETH_BUDGET',
        budget_wei: '1',
        target_base_tdh_per_day_hundredths: '1'
      },
      new CollectingWorkBudget(20000)
    )
  ).toThrow('search mode');
  expect(() => solveBudget([candidate('one')], '1'.repeat(79))).toThrow(
    'ETH budget'
  );
});
