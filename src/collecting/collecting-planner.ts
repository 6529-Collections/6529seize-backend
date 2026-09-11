import { collectingHash } from '@/collecting/collecting-analysis';
import { CollectingAnalysis } from '@/collecting/collecting.types';
import { BadRequestException } from '@/exceptions';

/** Candidates must come from validated order depth, never indicative floor prices. */
export interface CollectingCandidate {
  candidate_id: string;
  order_id: string;
  asset_key: string;
  quantity_available: string;
  unit_price_wei: string;
  execution_group: string;
  group_cost_wei: string;
  inventory_key: string;
  inventory_quantity: string;
  valid_until: string;
}

export interface CollectingPlannerOptions {
  evaluated_at: string;
  budget_wei?: string;
  max_states?: number;
}

export interface CollectingAcquisitionPlan {
  plan_id: string;
  analysis_id: string;
  status: 'complete' | 'partial' | 'unavailable';
  optimality: 'proven_within_candidates' | 'best_found';
  total_cost_wei: string;
  legs: Array<{
    candidate_id: string;
    order_id: string;
    asset_key: string;
    quantity: string;
  }>;
  remaining_requirements: Array<{
    requirement_id: string;
    missing_quantity: string;
  }>;
  projected_profile_complete: boolean;
  projected_profile_satisfied_count: number;
  recipient: string | null;
  states_examined: number;
  candidate_count: number;
  evaluated_at: string;
  method: 'bounded_integer_set_cover_v1';
}

interface Candidate {
  source: CollectingCandidate;
  maximum: number;
  price: bigint;
  overhead: bigint;
  inventory: number;
  covers: number[];
}

interface State {
  remaining: number[];
  cost: bigint;
  selected: Map<string, number>;
  groups: Set<string>;
  inventory: Map<string, number>;
}

function amount(value: string, label: string): bigint {
  if (!/^(0|[1-9]\d{0,77})$/.test(value))
    throw new BadRequestException(`Invalid ${label}`);
  const parsed = BigInt(value);
  if (
    parsed >
    BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  )
    throw new BadRequestException(`Invalid ${label}`);
  return parsed;
}

function quantity(value: string): number {
  const parsed = amount(value, 'quantity');
  if (parsed > BigInt(9999))
    throw new BadRequestException('Planner quantity exceeds 9999');
  return Number(parsed);
}

function parseCandidates(
  analysis: CollectingAnalysis,
  input: CollectingCandidate[],
  at: number
): Candidate[] {
  if (input.length > 2000)
    throw new BadRequestException(
      'Planner supports at most 2000 candidates per run'
    );
  const seen = new Set<string>();
  const orders = new Set<string>();
  const groups = new Map<string, string>();
  const inventories = new Map<string, string>();
  return input
    .map((source) => {
      if (
        !source.candidate_id ||
        !source.order_id ||
        seen.has(source.candidate_id) ||
        orders.has(source.order_id)
      )
        throw new BadRequestException(
          'Repeated or missing candidate/order identity'
        );
      seen.add(source.candidate_id);
      orders.add(source.order_id);
      if (!source.execution_group || !source.inventory_key)
        throw new BadRequestException(
          'Execution and inventory groups are required'
        );
      const groupCost = groups.get(source.execution_group);
      const inventory = inventories.get(source.inventory_key);
      if (
        (groupCost !== undefined && groupCost !== source.group_cost_wei) ||
        (inventory !== undefined && inventory !== source.inventory_quantity)
      )
        throw new BadRequestException(
          'Inconsistent execution cost or shared inventory'
        );
      groups.set(source.execution_group, source.group_cost_wei);
      inventories.set(source.inventory_key, source.inventory_quantity);
      const expiry = Date.parse(source.valid_until);
      if (!Number.isFinite(expiry))
        throw new BadRequestException('Invalid candidate expiry');
      return {
        source,
        maximum: expiry > at ? quantity(source.quantity_available) : 0,
        price: amount(source.unit_price_wei, 'price'),
        overhead: amount(source.group_cost_wei, 'execution cost'),
        inventory: quantity(source.inventory_quantity),
        covers: analysis.requirements.flatMap((requirement, index) =>
          requirement.asset_keys.includes(source.asset_key) ? [index] : []
        )
      };
    })
    .filter((candidate) => candidate.maximum > 0 && candidate.covers.length > 0)
    .sort((a, b) => a.source.candidate_id.localeCompare(b.source.candidate_id));
}

function missing(state: State): number {
  return state.remaining.reduce((sum, count) => sum + count, 0);
}

function better(candidate: State, current: State): boolean {
  const difference = missing(candidate) - missing(current);
  return difference < 0 || (difference === 0 && candidate.cost < current.cost);
}

function maximum(candidate: Candidate, state: State): number {
  const need = Math.max(
    0,
    ...candidate.covers.map((index) => state.remaining[index])
  );
  return Math.min(
    candidate.maximum -
      (state.selected.get(candidate.source.candidate_id) ?? 0),
    candidate.inventory -
      (state.inventory.get(candidate.source.inventory_key) ?? 0),
    need
  );
}

function add(candidate: Candidate, count: number, state: State): State {
  const cost =
    candidate.price * BigInt(count) +
    (state.groups.has(candidate.source.execution_group)
      ? BigInt(0)
      : candidate.overhead);
  const remaining = state.remaining.slice();
  candidate.covers.forEach((index) => {
    remaining[index] = Math.max(0, remaining[index] - count);
  });
  const selected = new Map(state.selected);
  selected.set(
    candidate.source.candidate_id,
    (selected.get(candidate.source.candidate_id) ?? 0) + count
  );
  const inventory = new Map(state.inventory);
  inventory.set(
    candidate.source.inventory_key,
    (inventory.get(candidate.source.inventory_key) ?? 0) + count
  );
  return {
    remaining,
    cost: state.cost + cost,
    selected,
    inventory,
    groups: new Set(
      Array.from(state.groups).concat(candidate.source.execution_group)
    )
  };
}

function greedy(
  candidates: Candidate[],
  initial: State,
  budget: bigint | undefined
): State {
  let state = initial;
  for (let step = 0; step < candidates.length && missing(state) > 0; step++) {
    let choice:
      | { candidate: Candidate; count: number; cost: bigint }
      | undefined;
    let choiceCoverage = 0;
    for (const candidate of candidates) {
      let count = maximum(candidate, state);
      if (budget !== undefined && candidate.price > BigInt(0)) {
        const overhead = state.groups.has(candidate.source.execution_group)
          ? BigInt(0)
          : candidate.overhead;
        const available = budget - state.cost - overhead;
        if (available < BigInt(0)) continue;
        const affordable = available / candidate.price;
        count = Math.min(
          count,
          Number(affordable > BigInt(9999) ? BigInt(9999) : affordable)
        );
      }
      if (!count) continue;
      const cost =
        candidate.price * BigInt(count) +
        (state.groups.has(candidate.source.execution_group)
          ? BigInt(0)
          : candidate.overhead);
      if (budget !== undefined && state.cost + cost > budget) continue;
      const coverage = candidate.covers.reduce(
        (sum, index) => sum + Math.min(state.remaining[index], count),
        0
      );
      if (
        !choice ||
        cost * BigInt(choiceCoverage) < choice.cost * BigInt(coverage)
      ) {
        choice = { candidate, count, cost };
        choiceCoverage = coverage;
      }
    }
    if (!choice) break;
    state = add(choice.candidate, choice.count, state);
  }
  return state;
}

/** The common one-copy Memes set decomposes exactly when no inventory or route
 * cost connects distinct missing cards. This remains linearithmic for large sets. */
function disjointUnitPlan(
  candidates: Candidate[],
  initial: State,
  budget: bigint | undefined
): State | undefined {
  if (initial.remaining.some((count) => count > 1)) return undefined;
  const groups = new Map<string, number>();
  const inventory = new Map<string, number>();
  const choices = new Map<number, Candidate>();
  for (const candidate of candidates) {
    const covers = candidate.covers.filter(
      (index) => initial.remaining[index] > 0
    );
    if (!covers.length || candidate.inventory < 1) continue;
    if (covers.length > 1) return undefined;
    const index = covers[0];
    for (const [map, key] of [
      [groups, candidate.source.execution_group],
      [inventory, candidate.source.inventory_key]
    ] as const) {
      if (map.has(key) && map.get(key) !== index) return undefined;
      map.set(key, index);
    }
    const current = choices.get(index);
    if (
      !current ||
      candidate.price + candidate.overhead < current.price + current.overhead
    )
      choices.set(index, candidate);
  }
  const cheapest = Array.from(choices.values()).sort((a, b) => {
    const difference = a.price + a.overhead - b.price - b.overhead;
    return difference < BigInt(0)
      ? -1
      : difference > BigInt(0)
        ? 1
        : a.source.candidate_id.localeCompare(b.source.candidate_id);
  });
  let state = initial;
  for (const candidate of cheapest) {
    const next = add(candidate, 1, state);
    if (budget === undefined || next.cost <= budget) state = next;
  }
  return state;
}

function search(
  candidates: Candidate[],
  initial: State,
  budget: bigint | undefined,
  stateLimit: number
) {
  const exact = disjointUnitPlan(candidates, initial, budget);
  if (exact)
    return { best: exact, examined: candidates.length, exhaustive: true };
  let best = greedy(candidates, initial, budget);
  if (candidates.length > 128)
    return { best, examined: candidates.length, exhaustive: false };
  let examined = 0;
  let exhaustive = true;
  const visit = (index: number, state: State): void => {
    if (examined >= stateLimit) {
      exhaustive = false;
      return;
    }
    examined++;
    if (better(state, best)) best = state;
    if (
      !missing(state) ||
      index >= candidates.length ||
      (!missing(best) && state.cost >= best.cost)
    )
      return;
    const candidate = candidates[index];
    const max = maximum(candidate, state);
    let counts: number[];
    if (max <= 20) {
      counts = Array.from({ length: max }, (_, offset) => max - offset);
    } else {
      // Large edition quantities use explicit breakpoints; do not label this exhaustive.
      exhaustive = false;
      counts = Array.from(
        new Set([
          max,
          1,
          ...candidate.covers.map((covered) =>
            Math.min(max, state.remaining[covered])
          )
        ])
      ).sort((a, b) => b - a);
    }
    for (const count of counts) {
      const next = add(candidate, count, state);
      if (budget === undefined || next.cost <= budget) visit(index + 1, next);
      if (examined >= stateLimit) break;
    }
    visit(index + 1, state);
  };
  visit(0, initial);
  return { best, examined, exhaustive };
}

export function planCollectingAcquisitions(
  analysis: CollectingAnalysis,
  input: CollectingCandidate[],
  options: CollectingPlannerOptions
): CollectingAcquisitionPlan {
  const at = Date.parse(options.evaluated_at);
  const maxStates = options.max_states ?? 25000;
  if (
    !Number.isFinite(at) ||
    !Number.isSafeInteger(maxStates) ||
    maxStates < 1 ||
    maxStates > 100000
  )
    throw new BadRequestException('Invalid planner bounds');
  const budget =
    options.budget_wei === undefined
      ? undefined
      : amount(options.budget_wei, 'budget');
  const candidates = parseCandidates(analysis, input, at);
  const initial: State = {
    remaining: analysis.requirements.map((requirement) =>
      quantity(requirement.missing_quantity)
    ),
    cost: BigInt(0),
    selected: new Map(),
    groups: new Set(),
    inventory: new Map()
  };
  const { best, examined, exhaustive } = search(
    candidates,
    initial,
    budget,
    Math.min(
      maxStates,
      Math.max(
        1,
        Math.floor(2000000 / Math.max(1, analysis.requirements.length))
      )
    )
  );
  const selected = candidates.filter((candidate) =>
    best.selected.has(candidate.source.candidate_id)
  );
  const remaining = best.remaining.flatMap((count, index) =>
    count > 0
      ? [
          {
            requirement_id: analysis.requirements[index].id,
            missing_quantity: String(count)
          }
        ]
      : []
  );
  const profileSatisfied = analysis.counts_toward_profile
    ? best.remaining.filter((count) => count === 0).length
    : analysis.satisfied_count;
  const result: Omit<CollectingAcquisitionPlan, 'plan_id'> = {
    analysis_id: analysis.analysis_id,
    status: !missing(best)
      ? 'complete'
      : selected.length
        ? 'partial'
        : 'unavailable',
    optimality: exhaustive ? 'proven_within_candidates' : 'best_found',
    total_cost_wei: best.cost.toString(),
    legs: selected.map((candidate) => ({
      candidate_id: candidate.source.candidate_id,
      order_id: candidate.source.order_id,
      asset_key: candidate.source.asset_key,
      quantity: String(best.selected.get(candidate.source.candidate_id))
    })),
    remaining_requirements: remaining,
    projected_profile_complete:
      analysis.complete || (analysis.counts_toward_profile && !missing(best)),
    projected_profile_satisfied_count: profileSatisfied,
    recipient: analysis.recipient,
    states_examined: examined,
    candidate_count: candidates.length,
    evaluated_at: options.evaluated_at,
    method: 'bounded_integer_set_cover_v1'
  };
  return { plan_id: collectingHash(result), ...result };
}
