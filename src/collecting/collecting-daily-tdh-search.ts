import { CollectingTdhTargetSelection } from '@/collecting/collecting-tdh-target.types';
import { CollectingTdhTargetCandidate } from '@/collecting/collecting-tdh-target.types';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { BadRequestException } from '@/exceptions';

const MAX_CANDIDATES = 2000;
const MAX_EVALUATIONS = 128;
const MAX_ORDERS = 128;
const MAX_QUANTITY_PER_ASSET = 9999;
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const UINT_PATTERN = /^(0|[1-9]\d*)$/;
const POSITIVE_UINT_PATTERN = /^[1-9]\d*$/;

export type CollectingDailyTdhCandidate = CollectingTdhTargetCandidate & {
  rate_hundredths: string;
  unique: boolean;
};

export type CollectingDailyTdhSearchInput = {
  mode: 'BASE_TDH_TARGET' | 'ETH_BUDGET';
  target_base_tdh_per_day_hundredths?: string;
  budget_wei?: string;
};

export interface CollectingDailyTdhSearchResult {
  selected: CollectingTdhTargetSelection[];
  base_tdh_per_day_hundredths: string;
  purchase_cost_wei: string;
  signed_fees_wei: string;
  search: {
    evaluated_portfolios: number;
    candidate_count: number;
    stop_reason: 'COMPLETE' | 'TIME_LIMIT' | 'EVALUATION_LIMIT';
    optimality: 'BEST_FOUND';
  };
}

interface PreparedCandidate {
  candidate: CollectingDailyTdhCandidate;
  cost: bigint;
  fees: bigint;
  rate: bigint;
  maximumQuantity: number;
}

interface Portfolio {
  selected: CollectingTdhTargetSelection[];
  rate: bigint;
  cost: bigint;
  fees: bigint;
  key: string;
}

function parseUint(value: string | undefined, name: string): bigint {
  if (
    value === undefined ||
    value.length > 78 ||
    !UINT_PATTERN.test(value) ||
    BigInt(value) > UINT256_MAX
  )
    throw new BadRequestException(`Invalid ${name}`);
  return BigInt(value);
}

function prepareCandidates(
  supplied: CollectingDailyTdhCandidate[]
): PreparedCandidate[] {
  if (
    supplied.length > MAX_CANDIDATES ||
    new Set(supplied.map(({ id }) => id)).size !== supplied.length
  )
    throw new BadRequestException('Invalid daily TDH candidate bounds');

  return supplied
    .map((candidate) => {
      if (
        !candidate.id ||
        !candidate.asset_key ||
        !candidate.maker ||
        !Number.isInteger(candidate.quantity_step) ||
        candidate.quantity_step < 1 ||
        !Number.isInteger(candidate.available_quantity) ||
        candidate.available_quantity < candidate.quantity_step ||
        candidate.available_quantity > MAX_QUANTITY_PER_ASSET ||
        !POSITIVE_UINT_PATTERN.test(candidate.step_cost_wei) ||
        !UINT_PATTERN.test(candidate.step_fees_wei) ||
        !UINT_PATTERN.test(candidate.rate_hundredths)
      )
        throw new BadRequestException('Invalid daily TDH candidate');
      const cost = parseUint(candidate.step_cost_wei, 'candidate cost');
      const fees = parseUint(candidate.step_fees_wei, 'candidate fees');
      const rate = parseUint(candidate.rate_hundredths, 'candidate rate');
      if (
        fees > cost ||
        (candidate.unique &&
          (candidate.quantity_step !== 1 || candidate.available_quantity !== 1))
      )
        throw new BadRequestException('Invalid daily TDH candidate');
      return {
        candidate,
        cost,
        fees,
        rate,
        maximumQuantity:
          candidate.available_quantity -
          (candidate.available_quantity % candidate.quantity_step)
      };
    })
    .filter(({ rate }) => rate > BigInt(0));
}

function compareId(a: PreparedCandidate, b: PreparedCandidate): number {
  return a.candidate.id.localeCompare(b.candidate.id);
}

function compareEfficiency(a: PreparedCandidate, b: PreparedCandidate): number {
  const left = a.cost * b.rate * BigInt(b.candidate.quantity_step);
  const right = b.cost * a.rate * BigInt(a.candidate.quantity_step);
  if (left !== right) return left < right ? -1 : 1;
  return compareId(a, b);
}

function compareCost(a: PreparedCandidate, b: PreparedCandidate): number {
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  return compareEfficiency(a, b);
}

function compareYield(a: PreparedCandidate, b: PreparedCandidate): number {
  const aYield = a.rate * BigInt(a.candidate.quantity_step);
  const bYield = b.rate * BigInt(b.candidate.quantity_step);
  if (aYield !== bYield) return aYield > bYield ? -1 : 1;
  return compareEfficiency(a, b);
}

function maximumAffordableQuantity(
  item: PreparedCandidate,
  currentCost: bigint,
  budget: bigint | undefined
): number {
  const remaining = (budget ?? UINT256_MAX) - currentCost;
  if (remaining < item.cost) return 0;
  const steps = remaining / item.cost;
  const affordable = steps * BigInt(item.candidate.quantity_step);
  return Number(
    affordable < BigInt(item.maximumQuantity)
      ? affordable
      : BigInt(item.maximumQuantity)
  );
}

function capQuantity(
  item: PreparedCandidate,
  wanted: number,
  portfolio: Portfolio,
  assetQuantity: number,
  budget: bigint | undefined
): number {
  const step = item.candidate.quantity_step;
  const rateCapacity = Number(
    (UINT256_MAX - portfolio.rate) / item.rate > BigInt(MAX_QUANTITY_PER_ASSET)
      ? BigInt(MAX_QUANTITY_PER_ASSET)
      : (UINT256_MAX - portfolio.rate) / item.rate
  );
  const capped = Math.min(
    wanted,
    item.maximumQuantity,
    MAX_QUANTITY_PER_ASSET - assetQuantity,
    maximumAffordableQuantity(item, portfolio.cost, budget),
    rateCapacity
  );
  return capped - (capped % step);
}

function wantedQuantity(
  item: PreparedCandidate,
  portfolio: Portfolio,
  target: bigint | undefined
): number {
  if (target === undefined) return item.maximumQuantity;
  const remaining = target - portfolio.rate;
  if (remaining <= BigInt(0)) return 0;
  const needed = (remaining + item.rate - BigInt(1)) / item.rate;
  const step = BigInt(item.candidate.quantity_step);
  const rounded = ((needed + step - BigInt(1)) / step) * step;
  return Number(
    rounded > BigInt(MAX_QUANTITY_PER_ASSET)
      ? BigInt(MAX_QUANTITY_PER_ASSET)
      : rounded
  );
}

function emptyPortfolio(): Portfolio {
  return {
    selected: [],
    rate: BigInt(0),
    cost: BigInt(0),
    fees: BigInt(0),
    key: ''
  };
}

function addCandidate(
  portfolio: Portfolio,
  item: PreparedCandidate,
  quantity: number
): void {
  if (!quantity) return;
  const steps = BigInt(quantity / item.candidate.quantity_step);
  portfolio.selected.push({ candidate: item.candidate, quantity });
  portfolio.rate += item.rate * BigInt(quantity);
  portfolio.cost += item.cost * steps;
  portfolio.fees += item.fees * steps;
}

function buildPortfolio(
  ordered: PreparedCandidate[],
  target: bigint | undefined,
  budget: bigint | undefined,
  workBudget: CollectingWorkBudget,
  seedFirst = false
): Portfolio | null {
  const portfolio = emptyPortfolio();
  const inventories = new Set<string>();
  const uniqueAssets = new Set<string>();
  const assetQuantities = new Map<string, number>();
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    if (workBudget.expired()) return null;
    if (target !== undefined && portfolio.rate >= target) break;
    if (portfolio.selected.length >= MAX_ORDERS) break;
    const { candidate } = item;
    const inventory = `${candidate.asset_key}:${candidate.maker.toLowerCase()}`;
    const assetQuantity = assetQuantities.get(candidate.asset_key) ?? 0;
    if (
      inventories.has(inventory) ||
      uniqueAssets.has(candidate.asset_key) ||
      (candidate.unique && assetQuantity > 0)
    )
      continue;
    const quantity = capQuantity(
      item,
      seedFirst && index === 0
        ? candidate.quantity_step
        : wantedQuantity(item, portfolio, target),
      portfolio,
      assetQuantity,
      budget
    );
    if (!quantity) continue;
    addCandidate(portfolio, item, quantity);
    inventories.add(inventory);
    assetQuantities.set(candidate.asset_key, assetQuantity + quantity);
    if (candidate.unique) uniqueAssets.add(candidate.asset_key);
  }
  portfolio.key = portfolio.selected
    .map(({ candidate, quantity }) => `${candidate.id}:${quantity}`)
    .join('|');
  return portfolio;
}

function preferPortfolio(
  candidate: Portfolio,
  current: Portfolio,
  mode: CollectingDailyTdhSearchInput['mode'],
  target: bigint | undefined
): boolean {
  if (mode === 'BASE_TDH_TARGET') {
    const candidateMet = candidate.rate >= target!;
    const currentMet = current.rate >= target!;
    if (candidateMet !== currentMet) return candidateMet;
    if (candidateMet) {
      if (candidate.cost !== current.cost) return candidate.cost < current.cost;
      if (candidate.rate !== current.rate) return candidate.rate < current.rate;
    } else {
      if (candidate.rate !== current.rate) return candidate.rate > current.rate;
      if (candidate.cost !== current.cost) return candidate.cost < current.cost;
    }
  } else {
    if (candidate.rate !== current.rate) return candidate.rate > current.rate;
    if (candidate.cost !== current.cost) return candidate.cost < current.cost;
  }
  return candidate.key.localeCompare(current.key) < 0;
}

function moveFirst(
  candidates: PreparedCandidate[],
  first: PreparedCandidate
): PreparedCandidate[] {
  return [first, ...candidates.filter((candidate) => candidate !== first)];
}

function resultFor(
  portfolio: Portfolio,
  candidateCount: number,
  evaluated: number,
  stopReason: CollectingDailyTdhSearchResult['search']['stop_reason']
): CollectingDailyTdhSearchResult {
  return {
    selected: portfolio.selected,
    base_tdh_per_day_hundredths: portfolio.rate.toString(),
    purchase_cost_wei: portfolio.cost.toString(),
    signed_fees_wei: portfolio.fees.toString(),
    search: {
      evaluated_portfolios: evaluated,
      candidate_count: candidateCount,
      stop_reason: stopReason,
      optimality: 'BEST_FOUND'
    }
  };
}

function prepareInput(input: CollectingDailyTdhSearchInput): {
  target: bigint | undefined;
  budget: bigint | undefined;
} {
  if (
    input.mode === 'BASE_TDH_TARGET' &&
    input.target_base_tdh_per_day_hundredths !== undefined &&
    input.budget_wei === undefined
  )
    return {
      target: parseUint(
        input.target_base_tdh_per_day_hundredths,
        'daily TDH target'
      ),
      budget: undefined
    };
  if (
    input.mode === 'ETH_BUDGET' &&
    input.budget_wei !== undefined &&
    input.target_base_tdh_per_day_hundredths === undefined
  )
    return {
      target: undefined,
      budget: parseUint(input.budget_wei, 'ETH budget')
    };
  throw new BadRequestException('Invalid daily TDH search mode');
}

/**
 * Searches bounded, deterministic greedy portfolio variants. BEST_FOUND never
 * claims a global optimum; every returned total is exact for its selections.
 */
export function solveCollectingDailyTdhSearch(
  candidates: CollectingDailyTdhCandidate[],
  input: CollectingDailyTdhSearchInput,
  workBudget: CollectingWorkBudget
): CollectingDailyTdhSearchResult {
  const { target, budget } = prepareInput(input);
  if (workBudget.expired())
    return resultFor(emptyPortfolio(), candidates.length, 0, 'TIME_LIMIT');
  const prepared = prepareCandidates(candidates);
  if (prepared.length === 0 || target === BigInt(0) || budget === BigInt(0))
    return resultFor(emptyPortfolio(), prepared.length, 0, 'COMPLETE');
  if (workBudget.expired())
    return resultFor(emptyPortfolio(), prepared.length, 0, 'TIME_LIMIT');

  prepared.sort(compareId);
  if (workBudget.expired())
    return resultFor(emptyPortfolio(), prepared.length, 0, 'TIME_LIMIT');
  const efficient = prepared.slice().sort(compareEfficiency);
  let best = emptyPortfolio();
  let evaluated = 0;
  let stopReason: CollectingDailyTdhSearchResult['search']['stop_reason'] =
    'COMPLETE';
  const evaluate = (
    ordered: PreparedCandidate[],
    seedFirst = false
  ): boolean => {
    if (evaluated >= MAX_EVALUATIONS) {
      stopReason = 'EVALUATION_LIMIT';
      return false;
    }
    const portfolio = buildPortfolio(
      ordered,
      target,
      budget,
      workBudget,
      seedFirst
    );
    if (!portfolio) {
      stopReason = 'TIME_LIMIT';
      return false;
    }
    evaluated++;
    if (preferPortfolio(portfolio, best, input.mode, target)) best = portfolio;
    return true;
  };
  const evaluateSorted = (
    comparator: (a: PreparedCandidate, b: PreparedCandidate) => number
  ): boolean => {
    if (workBudget.expired()) {
      stopReason = 'TIME_LIMIT';
      return false;
    }
    return evaluate(prepared.slice().sort(comparator));
  };
  if (
    !evaluate(efficient) ||
    !evaluateSorted(compareCost) ||
    !evaluateSorted(compareYield)
  )
    return resultFor(best, prepared.length, evaluated, stopReason);
  for (const first of prepared) {
    if (!evaluate(moveFirst(efficient, first), true)) break;
  }
  return resultFor(best, prepared.length, evaluated, stopReason);
}
