import { isAddress } from 'ethers';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  assertCollectingTdhParity,
  CollectingTdhProjection,
  CollectingTdhSource,
  createCollectingTdhProjector
} from '@/collecting/collecting-tdh-projection';
import {
  COLLECT_TDH_TARGET_LIMITS as LIMIT,
  CollectingTdhTargetCandidate,
  CollectingTdhTargetRequest,
  CollectingTdhTargetSelection,
  CollectingTdhTargetStop
} from '@/collecting/collecting-tdh-target.types';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { MARKET_BATCH_LIMITS } from '@/marketplace/market-batch.schema';
import { NULL_ADDRESS } from '@/constants';
import { marketUintSchema } from '@/marketplace/seaport.schema';

interface State {
  key: string;
  quantities: number[];
  cost: bigint;
}
interface EfficiencySeed {
  state: State;
  estimatedYield: bigint;
}
function compareEfficiency(a: EfficiencySeed, b: EfficiencySeed): number {
  const left = a.state.cost * b.estimatedYield,
    right = b.state.cost * a.estimatedYield;
  return left < right ? -1 : left > right ? 1 : compareState(a.state, b.state);
}

function compareState(a: State, b: State): number {
  return a.cost < b.cost
    ? -1
    : a.cost > b.cost
      ? 1
      : a.key.localeCompare(b.key);
}

function validateRequest(
  source: CollectingTdhSource,
  request: CollectingTdhTargetRequest,
  now: number
) {
  if (
    request.profile_id !== source.account.profile_id ||
    !isAddress(request.recipient) ||
    !source.account.wallets.includes(request.recipient.toLowerCase()) ||
    !/^(0|[1-9]\d{0,15})$/.test(request.target_tdh) ||
    BigInt(request.target_tdh) > BigInt(Number.MAX_SAFE_INTEGER) ||
    ![1, 30, 90, 365].includes(request.horizon_days)
  )
    throw new BadRequestException(
      'A valid profile target and an in-profile recipient are required'
    );
  const age = now - Date.parse(source.input.snapshot_timestamp);
  if (!Number.isFinite(age) || age < 0 || age > 36 * 3600000)
    throw new CustomApiCompliantException(
      503,
      'A recent official TDH snapshot is required'
    );
}

function stateFor(
  quantities: number[],
  candidates: CollectingTdhTargetCandidate[],
  budget?: bigint
): State | null {
  let cost = BigInt(0),
    orders = 0;
  const assets = new Map<string, number>(),
    inventories = new Set<string>();
  for (let i = 0; i < quantities.length; i++) {
    const quantity = quantities[i];
    if (quantity === 0) continue;
    const candidate = candidates[i];
    const inventory = `${candidate.asset_key}:${candidate.maker}`;
    // Alternative listings from one maker may overlap the same inventory.
    if (
      !Number.isInteger(quantity) ||
      quantity < 0 ||
      quantity > candidate.available_quantity ||
      quantity % candidate.quantity_step !== 0 ||
      inventories.has(inventory)
    )
      return null;
    inventories.add(inventory);
    orders++;
    const total = (assets.get(candidate.asset_key) ?? 0) + quantity;
    if (total > LIMIT.quantity_per_asset) return null;
    assets.set(candidate.asset_key, total);
    cost +=
      BigInt(candidate.step_cost_wei) *
      BigInt(quantity / candidate.quantity_step);
  }
  if (
    !marketUintSchema.safeParse(cost.toString()).success ||
    orders > MARKET_BATCH_LIMITS.max_orders ||
    (budget !== undefined && cost > budget)
  )
    return null;
  return {
    quantities,
    cost,
    key: quantities
      .map((q, i) => (q ? `${candidates[i].id}:${q}` : ''))
      .filter(Boolean)
      .join('|')
  };
}

function completionGroups(source: CollectingTdhSource): string[][] {
  const memes = source.input.tokens.filter((token) => token.family === 'memes');
  const keys = (tokens: typeof memes) =>
    tokens.map((token) =>
      collectingAssetKey(token.contract, String(token.token_id))
    );
  return [
    keys(memes),
    keys(memes.filter((token) => token.token_id <= 3)),
    keys(memes.filter((token) => token.token_id === 4)),
    ...source.input.seasons.map((season) =>
      keys(
        memes.filter(
          (token) =>
            token.token_id >= season.start_index &&
            token.token_id <= season.end_index
        )
      )
    )
  ].filter((group) => group.length > 0);
}

function completionSeeds(
  source: CollectingTdhSource,
  baseline: CollectingTdhProjection,
  candidates: CollectingTdhTargetCandidate[],
  deadline: number
): number[][] {
  const balances = new Map(
    baseline.baseline.tokens.map((token) => [token.asset_key, token.balance])
  );
  const byAsset = new Map<
    string,
    Array<{ candidate: CollectingTdhTargetCandidate; index: number }>
  >();
  candidates.forEach((candidate, index) => {
    const group = byAsset.get(candidate.asset_key) ?? [];
    group.push({ candidate, index });
    byAsset.set(candidate.asset_key, group);
  });
  return completionGroups(source).flatMap((group) => {
    if (Date.now() >= deadline) return [];
    const level = Math.min(...group.map((key) => balances.get(key) ?? 0)) + 1;
    const quantities = candidates.map(() => 0);
    for (const key of group) {
      const missing = Math.max(0, level - (balances.get(key) ?? 0));
      if (!missing) continue;
      const choices = (byAsset.get(key) ?? [])
        .map(({ candidate, index }) => ({
          candidate,
          index,
          quantity:
            Math.ceil(missing / candidate.quantity_step) *
            candidate.quantity_step
        }))
        .filter(
          (choice) => choice.quantity <= choice.candidate.available_quantity
        )
        .sort((a, b) => {
          const costA =
            BigInt(a.candidate.step_cost_wei) *
            BigInt(a.quantity / a.candidate.quantity_step);
          const costB =
            BigInt(b.candidate.step_cost_wei) *
            BigInt(b.quantity / b.candidate.quantity_step);
          return costA < costB
            ? -1
            : costA > costB
              ? 1
              : a.candidate.id.localeCompare(b.candidate.id);
        });
      if (!choices.length) return [];
      quantities[choices[0].index] = choices[0].quantity;
    }
    return quantities.some(Boolean) ? [quantities] : [];
  });
}

/** Heuristics schedule portfolios; only a complete canonical replay establishes success. */
function prepareTargetSearch(
  source: CollectingTdhSource,
  request: CollectingTdhTargetRequest,
  supplied: CollectingTdhTargetCandidate[],
  now = Date.now(),
  deadline = now + LIMIT.duration_ms
) {
  validateRequest(source, request, now);
  const at = new Date(now);
  const evaluatedAt = new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() + request.horizon_days
    )
  ).toISOString();
  const historyWork = source.input.transactions.reduce(
    (sum, tx) => sum + tx.token_count + 1,
    0
  );
  const baseWork = Math.max(
    1,
    historyWork * source.account.wallets.length + source.input.tokens.length
  );
  const workUsed = baseWork * 2; // Published-snapshot parity and the future no-purchase baseline.
  if (workUsed > LIMIT.replay_work || Date.now() >= deadline)
    throw new CustomApiCompliantException(
      503,
      'The profile exceeds the target analysis work window'
    );
  assertCollectingTdhParity(source.input, source.official);
  const project = createCollectingTdhProjector({
    ...source.input,
    evaluated_at: evaluatedAt,
    transfers: []
  });
  const baseline = project([]);
  if (!Number.isSafeInteger(baseline.baseline.boosted_tdh))
    throw new CustomApiCompliantException(
      503,
      'Baseline TDH exceeds exact supported precision'
    );
  const target =
    request.target_mode === 'ADDITIONAL_OVER_BASELINE'
      ? BigInt(baseline.baseline.boosted_tdh) + BigInt(request.target_tdh)
      : BigInt(request.target_tdh);
  const known = new Map(
    source.input.tokens.map((token) => [
      collectingAssetKey(token.contract, String(token.token_id)),
      token
    ])
  );
  const owned = new Map(
    baseline.baseline.tokens.map((token) => [token.asset_key, token.balance])
  );
  const candidates = validateCandidates(supplied, known);
  return {
    source,
    request,
    now,
    deadline,
    historyWork,
    baseWork,
    workUsed,
    project,
    baseline,
    target,
    known,
    owned,
    candidates
  };
}
function validateCandidates(
  supplied: CollectingTdhTargetCandidate[],
  known: ReadonlyMap<string, unknown>
) {
  const candidates = supplied.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (
    candidates.length > LIMIT.candidates ||
    new Set(candidates.map((candidate) => candidate.id)).size !==
      candidates.length
  )
    throw new BadRequestException('Invalid target candidate bounds');
  for (const candidate of candidates) {
    if (
      !known.has(candidate.asset_key) ||
      !Number.isInteger(candidate.quantity_step) ||
      candidate.quantity_step < 1 ||
      !Number.isInteger(candidate.available_quantity) ||
      candidate.available_quantity < candidate.quantity_step ||
      candidate.available_quantity > LIMIT.quantity_per_asset ||
      !/^[1-9]\d{0,77}$/.test(candidate.step_cost_wei) ||
      !/^(0|[1-9]\d{0,77})$/.test(candidate.step_fees_wei) ||
      BigInt(candidate.step_fees_wei) > BigInt(candidate.step_cost_wei)
    )
      throw new BadRequestException('Invalid trusted target candidate');
  }
  return candidates;
}

type PreparedTarget = ReturnType<typeof prepareTargetSearch>;

function candidateQuantities(
  candidate: CollectingTdhTargetCandidate,
  current: number,
  projection: CollectingTdhProjection,
  target: bigint
): number[] {
  const next = new Set([
    current ? current * 2 : candidate.quantity_step,
    candidate.available_quantity -
      (candidate.available_quantity % candidate.quantity_step)
  ]);
  // Do not consume one full replay per edition for large lots.
  if (current < candidate.quantity_step * 8)
    next.add(current + candidate.quantity_step);
  if (projection.additional_tdh > 0 && current > 0) {
    const need = Number(target - BigInt(projection.baseline.boosted_tdh));
    const guess =
      Math.ceil(
        (current * need) / projection.additional_tdh / candidate.quantity_step
      ) * candidate.quantity_step;
    next.add(guess);
    next.add(guess - candidate.quantity_step);
  }
  return Array.from(next).filter(
    (quantity) => quantity > current && quantity <= candidate.available_quantity
  );
}

function preferProjection(
  state: State,
  projection: CollectingTdhProjection,
  best: State,
  bestProjection: CollectingTdhProjection,
  feasible: boolean,
  met: boolean
): boolean {
  if (met && !feasible) return true;
  if (!met && feasible) return false;
  if (!met)
    return (
      projection.proposed.boosted_tdh > bestProjection.proposed.boosted_tdh ||
      (projection.proposed.boosted_tdh ===
        bestProjection.proposed.boosted_tdh &&
        compareState(state, best) < 0)
    );
  if (state.cost !== best.cost) return state.cost < best.cost;
  if (projection.proposed.boosted_tdh !== bestProjection.proposed.boosted_tdh)
    return (
      projection.proposed.boosted_tdh < bestProjection.proposed.boosted_tdh
    );
  return state.key.localeCompare(best.key) < 0;
}

class TargetSearch {
  private best: State;
  private bestProjection: CollectingTdhProjection;
  private feasible: boolean;
  private workUsed: number;
  private evaluations = 0;
  private generated = 0;
  private stop: CollectingTdhTargetStop = 'COMPLETE';
  private readonly seen = new Set<string>();
  private readonly frontier: State[] = [];
  private readonly bundles: State[] = [];
  private readonly efficient: EfficiencySeed[] = [];
  private readonly evaluated = new Set<string>();
  private readonly budget: bigint | undefined;

  constructor(private readonly context: PreparedTarget) {
    this.best = stateFor(
      context.candidates.map(() => 0),
      context.candidates
    )!;
    this.bestProjection = context.baseline;
    this.feasible =
      BigInt(context.baseline.proposed.boosted_tdh) >= context.target;
    this.workUsed = context.workUsed;
    this.seen.add(this.best.key);
    this.budget =
      context.request.budget_wei === undefined
        ? undefined
        : BigInt(context.request.budget_wei);
  }

  private uniqueInventory(quantities: number[]): boolean {
    const seen = new Set<string>();
    const { candidates, known, owned } = this.context;
    for (let i = 0; i < quantities.length; i++) {
      if (
        !quantities[i] ||
        known.get(candidates[i].asset_key)!.family === 'memes'
      )
        continue;
      const key = candidates[i].asset_key;
      if ((owned.get(key) ?? 0) > 0 || seen.has(key) || quantities[i] !== 1)
        return false;
      seen.add(key);
    }
    return true;
  }

  private enqueue(quantities: number[], bundle = false): void {
    if (++this.generated > LIMIT.generated_states) {
      this.stop = 'FRONTIER_LIMIT';
      return;
    }
    const state = stateFor(quantities, this.context.candidates, this.budget);
    if (
      !state ||
      this.seen.has(state.key) ||
      (this.feasible && state.cost > this.best.cost) ||
      !this.uniqueInventory(quantities)
    )
      return;
    this.seen.add(state.key);
    const queue = bundle ? this.bundles : this.frontier;
    queue.push(state);
    queue.sort(compareState);
    if (queue.length > LIMIT.frontier) {
      queue.pop();
      this.stop = 'FRONTIER_LIMIT';
    }
  }

  private selections(state: State): CollectingTdhTargetSelection[] {
    return this.context.candidates.flatMap((candidate, index) =>
      state.quantities[index]
        ? [{ candidate, quantity: state.quantities[index] }]
        : []
    );
  }

  private transfers(state: State) {
    const quantities = new Map<string, number>();
    this.selections(state).forEach((item) =>
      quantities.set(
        item.candidate.asset_key,
        (quantities.get(item.candidate.asset_key) ?? 0) + item.quantity
      )
    );
    return Array.from(quantities, ([key, quantity]) => ({
      contract: this.context.known.get(key)!.contract,
      token_id: this.context.known.get(key)!.token_id,
      quantity,
      from_address: NULL_ADDRESS,
      to_address: this.context.request.recipient,
      timestamp: new Date(this.context.now).toISOString()
    }));
  }

  private expand(state: State, projection: CollectingTdhProjection): void {
    const { candidates, deadline, target } = this.context;
    for (
      let index = 0;
      index < candidates.length &&
      this.generated < LIMIT.generated_states &&
      Date.now() < deadline;
      index++
    ) {
      for (const quantity of candidateQuantities(
        candidates[index],
        state.quantities[index],
        projection,
        target
      )) {
        const quantities = state.quantities.slice();
        quantities[index] = quantity;
        this.enqueue(quantities);
      }
    }
  }

  private seedEfficiency(): void {
    const { source, candidates, known, target, baseline, request, deadline } =
      this.context;
    const memesIndex = Math.max(
      0,
      ...source.input.tokens
        .filter((token) => token.family === 'memes')
        .map((token) => token.calculation_edition_size!)
    );
    const required = Number(target - BigInt(baseline.baseline.boosted_tdh));
    candidates.forEach((candidate, index) => {
      if (Date.now() >= deadline || this.generated >= LIMIT.generated_states)
        return;
      const token = known.get(candidate.asset_key)!;
      // Frozen base accrual only schedules exploration. It never establishes
      // profile gain, inherited history, boosts or target feasibility.
      const rate =
        token.family === 'memes'
          ? memesIndex / token.calculation_edition_size!
          : token.hodl_rate;
      const hundredths = Math.round(rate * 100);
      if (!Number.isSafeInteger(hundredths) || hundredths <= 0) return;
      const guess =
        Math.ceil(
          (required * 100) /
            hundredths /
            request.horizon_days /
            candidate.quantity_step
        ) * candidate.quantity_step;
      const choices = new Set([
        candidate.quantity_step,
        guess,
        candidate.available_quantity -
          (candidate.available_quantity % candidate.quantity_step)
      ]);
      for (const quantity of Array.from(choices)) {
        if (++this.generated > LIMIT.generated_states) break;
        if (
          quantity < candidate.quantity_step ||
          quantity > candidate.available_quantity
        )
          continue;
        const quantities = candidates.map(() => 0);
        quantities[index] = quantity;
        const state = stateFor(quantities, candidates, this.budget);
        if (!state || !this.uniqueInventory(quantities)) continue;
        this.efficient.push({
          state,
          estimatedYield: BigInt(hundredths) * BigInt(quantity)
        });
      }
      if (this.efficient.length > LIMIT.frontier) {
        this.efficient.sort(compareEfficiency);
        this.efficient.length = LIMIT.frontier;
        this.stop = 'FRONTIER_LIMIT';
      }
    });
    this.efficient.sort(compareEfficiency);
  }

  private next(): State {
    // Reserve every fourth replay for cost-ordered completion seeds so a large
    // cheap listing catalog cannot starve nonlinear set-completion portfolios.
    if (this.bundles.length && this.evaluations % 4 === 0)
      return this.bundles.shift()!;
    // Reserve a second lane for high-base-TDH-per-cost singletons/quantities;
    // hundreds of cheap low-yield asks cannot starve a useful Gradient/Pebble.
    if (this.efficient.length && this.evaluations % 4 === 1)
      return this.efficient.shift()!.state;
    if (this.frontier.length) return this.frontier.shift()!;
    if (this.bundles.length) return this.bundles.shift()!;
    return this.efficient.shift()!.state;
  }

  private evaluate(state: State): boolean {
    if (this.evaluated.has(state.key)) return true;
    if (this.feasible && state.cost > this.best.cost) return true;
    const transfers = this.transfers(state);
    const hypotheticalWork = transfers.reduce(
      (sum, transfer) => sum + transfer.quantity + 1,
      0
    );
    // Charge complete history again for every inventory validation and include
    // the per-copy work of hypothetical Memes in the proposed account replay.
    const cost =
      this.context.baseWork +
      (this.context.historyWork * transfers.length +
        hypotheticalWork * (transfers.length + 1)) *
        this.context.source.account.wallets.length;
    if (this.workUsed + cost > LIMIT.replay_work) {
      this.stop = 'WORK_LIMIT';
      return false;
    }
    this.workUsed += cost;
    this.evaluated.add(state.key);
    const projection = this.context.project(transfers);
    this.evaluations++;
    if (!Number.isSafeInteger(projection.proposed.boosted_tdh))
      throw new CustomApiCompliantException(
        503,
        'Projected TDH exceeds exact supported precision'
      );
    const met = BigInt(projection.proposed.boosted_tdh) >= this.context.target;
    if (
      preferProjection(
        state,
        projection,
        this.best,
        this.bestProjection,
        this.feasible,
        met
      )
    ) {
      this.best = state;
      this.bestProjection = projection;
      this.feasible = met;
    }
    if (!met) this.expand(state, projection);
    return true;
  }

  run() {
    const { source, baseline, candidates, deadline } = this.context;
    if (!this.feasible) {
      completionSeeds(source, baseline, candidates, deadline).forEach(
        (quantities) => this.enqueue(quantities, true)
      );
      this.seedEfficiency();
      this.expand(this.best, baseline);
    }
    while (
      this.frontier.length ||
      this.bundles.length ||
      this.efficient.length
    ) {
      if (this.evaluations >= LIMIT.evaluations) {
        this.stop = 'EVALUATION_LIMIT';
        break;
      }
      if (Date.now() >= deadline) {
        this.stop = 'TIME_LIMIT';
        break;
      }
      if (!this.evaluate(this.next())) break;
    }
    if (Date.now() >= deadline) this.stop = 'TIME_LIMIT';
    else if (
      this.generated >= LIMIT.generated_states &&
      this.stop === 'COMPLETE'
    )
      this.stop = 'FRONTIER_LIMIT';
    return this.result();
  }

  private result() {
    const selected = this.selections(this.best);
    let status:
      | 'NOT_FOUND_WITHIN_SEARCH'
      | 'NO_PURCHASE_NEEDED'
      | 'TARGET_MET_BEST_FOUND' = 'NOT_FOUND_WITHIN_SEARCH';
    if (this.feasible)
      status =
        this.best.cost === BigInt(0)
          ? 'NO_PURCHASE_NEEDED'
          : 'TARGET_MET_BEST_FOUND';
    const shortfall =
      this.context.target - BigInt(this.bestProjection.proposed.boosted_tdh);
    return {
      status,
      projection: this.bestProjection,
      target_total_tdh: this.context.target.toString(),
      shortfall_tdh: (shortfall > BigInt(0) ? shortfall : BigInt(0)).toString(),
      purchase_cost_wei: this.best.cost.toString(),
      signed_fees_wei: selected
        .reduce(
          (sum, item) =>
            sum +
            BigInt(item.candidate.step_fees_wei) *
              BigInt(item.quantity / item.candidate.quantity_step),
          BigInt(0)
        )
        .toString(),
      selected,
      search: {
        optimality: 'BEST_FOUND' as const,
        evaluated_count: this.evaluations,
        evaluation_limit: LIMIT.evaluations,
        work_used: this.workUsed,
        work_limit: LIMIT.replay_work,
        stop_reason: this.stop
      }
    };
  }
}

/** Freeze parity, baseline and projector once, before any optional market read. */
export function createCollectingTdhTargetSolver(
  source: CollectingTdhSource,
  request: CollectingTdhTargetRequest,
  now = Date.now(),
  deadline = now + LIMIT.duration_ms
) {
  const context = prepareTargetSearch(source, request, [], now, deadline);
  return (supplied: CollectingTdhTargetCandidate[]) =>
    new TargetSearch({
      ...context,
      candidates: validateCandidates(supplied, context.known)
    }).run();
}

/** The public request supplies only goals, never market prices or projection inputs. */
export function solveCollectingTdhTarget(
  source: CollectingTdhSource,
  request: CollectingTdhTargetRequest,
  supplied: CollectingTdhTargetCandidate[],
  now = Date.now(),
  deadline = now + LIMIT.duration_ms
) {
  return createCollectingTdhTargetSolver(
    source,
    request,
    now,
    deadline
  )(supplied);
}
