import { CompetitionDecisionConfig } from '@/competitions/competition.types';

export type NativeVotePoint = {
  readonly timestamp: number;
  readonly vote: number;
  readonly sequence: number;
};

export type NativeOutcome = {
  readonly type: string;
  readonly subtype?: string | null;
  readonly description: string;
  readonly credit?: string | null;
  readonly rep_category?: string | null;
  readonly amount?: number | null;
  readonly distribution?: readonly {
    amount?: number | null;
    description?: string | null;
  }[];
};

export type NativeAward = {
  readonly outcome_position: number;
  readonly type: string;
  readonly subtype: string | null;
  readonly description: string;
  readonly credit: string | null;
  readonly rep_category: string | null;
  readonly amount: number | null;
};

function orderedPoints(points: readonly NativeVotePoint[]): NativeVotePoint[] {
  return [...points].sort(
    (a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence
  );
}

function exactVoteEvaluator(
  points: readonly NativeVotePoint[],
  timeLockMs: number
): (time: number) => bigint {
  const ordered = orderedPoints(points);
  const areas: bigint[] = [];
  let area = BigInt(0);
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0)
      area +=
        BigInt(ordered[i - 1].vote) *
        (BigInt(ordered[i].timestamp) - BigInt(ordered[i - 1].timestamp));
    areas.push(area);
  }
  const indexAt = (time: number): number => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordered[middle].timestamp <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  const integral = (time: number): bigint => {
    const index = indexAt(time);
    return index < 0
      ? BigInt(0)
      : areas[index] +
          BigInt(ordered[index].vote) *
            (BigInt(time) - BigInt(ordered[index].timestamp));
  };
  return (time) =>
    timeLockMs <= 0
      ? BigInt(ordered[indexAt(time)]?.vote ?? 0)
      : integral(time) - integral(time - timeLockMs);
}

/** The legacy time lock is the integral of real-time vote over the full window. */
export function weightedNativeVote(
  points: readonly NativeVotePoint[],
  end: number,
  timeLockMs: number
): number {
  return (
    Number(exactVoteEvaluator(points, timeLockMs)(end)) /
    Math.max(1, timeLockMs)
  );
}

/** Floor the exact rational before converting the safe, persisted rating. */
export function flooredWeightedNativeVote(
  points: readonly NativeVotePoint[],
  end: number,
  timeLockMs: number
): number {
  const numerator = exactVoteEvaluator(points, timeLockMs)(end);
  const denominator = BigInt(Math.max(1, timeLockMs));
  const quotient = numerator / denominator;
  const floor =
    numerator < BigInt(0) && numerator % denominator !== BigInt(0)
      ? quotient - BigInt(1)
      : quotient;
  const rating = Number(floor);
  if (!Number.isSafeInteger(rating))
    throw new Error('Native weighted rating is outside the safe integer range');
  return rating;
}

/** Finds the beginning of the CURRENT continuous passing interval, including
 * dips between snapshots and linear crossings as old votes leave the window. */
export function nativeThresholdSince(
  points: readonly NativeVotePoint[],
  end: number,
  timeLockMs: number,
  threshold: number,
  submittedAt: number
): number | null {
  if (timeLockMs <= 0) {
    let since: number | null = threshold <= 0 ? submittedAt : null;
    for (const point of orderedPoints(points)) {
      if (point.timestamp > end) break;
      if (point.vote < threshold) since = null;
      else since ??= point.timestamp;
    }
    return since;
  }
  const evaluate = exactVoteEvaluator(points, timeLockMs);
  const passingNumerator = BigInt(threshold) * BigInt(timeLockMs);
  const times = new Set<number>([submittedAt, end]);
  for (const point of points) {
    if (point.timestamp >= submittedAt && point.timestamp <= end)
      times.add(point.timestamp);
    const expiry = point.timestamp + timeLockMs;
    if (expiry >= submittedAt && expiry <= end) times.add(expiry);
  }
  const checkpoints = Array.from(times).sort((a, b) => a - b);
  let previousTime = checkpoints[0];
  let previousScore = evaluate(previousTime);
  let since: number | null =
    previousScore >= passingNumerator ? previousTime : null;
  for (const timestamp of checkpoints.slice(1)) {
    const score = evaluate(timestamp);
    if (score < passingNumerator) since = null;
    else if (previousScore < passingNumerator) {
      const rise = score - previousScore;
      const distance =
        (passingNumerator - previousScore) *
        (BigInt(timestamp) - BigInt(previousTime));
      const offset = (distance + rise - BigInt(1)) / rise;
      since = Number(BigInt(previousTime) + offset);
    }
    previousTime = timestamp;
    previousScore = score;
  }
  return since;
}

export function nextNativeDecision(
  config: CompetitionDecisionConfig,
  after: number | null
): number | null {
  const strategy = config.strategy;
  if (!strategy) return null;
  const first = Number(strategy.first_decision_time);
  const gaps = Array.isArray(strategy.subsequent_decisions)
    ? strategy.subsequent_decisions.map(Number)
    : [];
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    gaps.some((gap) => !Number.isSafeInteger(gap) || gap <= 0)
  ) {
    throw new Error('Invalid native decision schedule');
  }
  if (after === null || after < first) return first;
  if (!gaps.length) return null;
  const cycle = gaps.reduce((sum, gap) => sum + gap, 0);
  const rolling = strategy.is_rolling === true;
  let occurrence = first;
  if (rolling) occurrence += Math.floor((after - first) / cycle) * cycle;
  for (const gap of gaps) {
    occurrence += gap;
    if (occurrence > after) return occurrence;
  }
  return null;
}

export function nativeWinnerCount(outcomes: readonly NativeOutcome[]): number {
  return outcomes.reduce(
    (count, outcome) => Math.max(count, outcome.distribution?.length ?? 1),
    0
  );
}

export function nativeAwardsForRank(
  outcomes: readonly NativeOutcome[],
  rank: number
): NativeAward[] {
  const result: NativeAward[] = [];
  outcomes.forEach((outcome, position) => {
    const distribution = outcome.distribution ?? [];
    if (
      (!distribution.length && rank > 1) ||
      (distribution.length > 0 && rank > distribution.length)
    )
      return;
    const part = distribution[rank - 1];
    result.push({
      outcome_position: position,
      type: outcome.type,
      subtype: outcome.subtype ?? null,
      description: `${outcome.description}${part?.description ? ` / ${part.description}` : ''}`,
      credit: outcome.credit ?? null,
      rep_category: outcome.rep_category ?? null,
      amount: part
        ? outcome.amount
          ? Math.floor(outcome.amount * ((part.amount ?? 0) / 100))
          : null
        : (outcome.amount ?? null)
    });
  });
  return result;
}

export function reducedNativeVotes(
  votes: readonly { entryId: string; value: number }[],
  available: number,
  scope: string
): readonly { entryId: string; value: number }[] {
  const credit = Math.floor(Math.max(0, available));
  if (scope === 'DROP')
    return votes.map((vote) => ({
      ...vote,
      value: Math.max(-credit, Math.min(credit, vote.value))
    }));
  const spent = votes.reduce((sum, vote) => sum + Math.abs(vote.value), 0);
  if (spent <= credit) return votes;
  // Truncate signed values toward zero: flooring a negative value can overspend.
  return votes.map((vote) => ({
    ...vote,
    value: Math.trunc((vote.value * credit) / spent)
  }));
}
