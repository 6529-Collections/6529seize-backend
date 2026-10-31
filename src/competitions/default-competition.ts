import { CompetitionLifecycle, CompetitionType } from '@/entities/ICompetition';
import type { CompetitionRecord } from '@/competitions/competition.repository';

export type DefaultCompetitionRecord = Pick<
  CompetitionRecord,
  | 'id'
  | 'type'
  | 'lifecycle'
  | 'published_at'
  | 'ended_at'
  | 'cancelled_at'
  | 'participation_starts_at'
  | 'participation_ends_at'
  | 'voting_starts_at'
  | 'voting_ends_at'
  | 'decision_config'
>;

type SelectionInput = {
  readonly id: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly phase: 'active' | 'upcoming' | 'completed';
  readonly boundaries: readonly number[];
};

const date = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

function nativeDecisionPending(
  config: DefaultCompetitionRecord['decision_config']
): boolean | null {
  try {
    const value: unknown =
      typeof config === 'string' ? JSON.parse(config) : config;
    if (value === null || typeof value !== 'object') return null;
    const next = (value as Record<string, unknown>).next_decision_time;
    if (next === null) return false;
    if (typeof next !== 'number' || !Number.isFinite(next)) return null;
    return true;
  } catch {
    return null;
  }
}

/** Native configuration is authoritative for every competition, including
 * original primaries whose physical wave still has a historical RANK type. */
export function normalizeDefaultCompetition(
  record: DefaultCompetitionRecord,
  now: number
): SelectionInput | null {
  if (
    record.published_at === null ||
    record.lifecycle === CompetitionLifecycle.DRAFT ||
    record.lifecycle === CompetitionLifecycle.CANCELLED ||
    (record.cancelled_at !== null && record.ended_at === null)
  )
    return null;
  const pending = nativeDecisionPending(record.decision_config);
  if (pending === null) return null;
  const starts = [
    date(record.participation_starts_at),
    date(record.voting_starts_at)
  ];
  const ends = [
    date(record.participation_ends_at),
    date(record.voting_ends_at)
  ];
  const start = starts.includes(null)
    ? null
    : Math.min(...(starts as number[]));
  const finiteEnds = ends.filter((end): end is number => end !== null);
  const closed =
    finiteEnds.length === ends.length && finiteEnds.every((end) => now > end);
  const completed =
    record.lifecycle === CompetitionLifecycle.ENDED ||
    record.ended_at !== null ||
    (closed && !pending && record.type !== CompetitionType.APPROVE);
  if (record.lifecycle === CompetitionLifecycle.ARCHIVED && !completed)
    return null;
  if (completed)
    return {
      id: record.id,
      start,
      end: date(record.ended_at) ?? (closed ? Math.max(...finiteEnds) : null),
      phase: 'completed',
      boundaries: []
    };
  return {
    id: record.id,
    start,
    end: null,
    phase: start !== null && now < start ? 'upcoming' : 'active',
    boundaries: [
      ...starts,
      ...ends.map((end) => (end === null ? null : end + 1))
    ].filter(
      (boundary): boundary is number => boundary !== null && boundary > now
    )
  };
}

type SortValue = string | number;
const compareValues = (left: SortValue, right: SortValue) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export function selectDefaultCompetition(
  inputs: readonly SelectionInput[],
  now: number
) {
  const ordered = [...inputs].sort((left, right) => {
    const priority = { active: 0, upcoming: 1, completed: 2 };
    const phaseOrder = priority[left.phase] - priority[right.phase];
    if (phaseOrder) return phaseOrder;
    const leftTime =
      left.phase === 'completed'
        ? -(left.end ?? -Infinity)
        : (left.start ?? -Infinity);
    const rightTime =
      right.phase === 'completed'
        ? -(right.end ?? -Infinity)
        : (right.start ?? -Infinity);
    return (
      compareValues(leftTime, rightTime) || compareValues(left.id, right.id)
    );
  });
  const boundaries = inputs
    .flatMap((input) => input.boundaries)
    .filter((boundary) => boundary > now);
  return {
    competition_id: ordered[0]?.id ?? null,
    evaluated_at: now,
    next_refresh_at: boundaries.reduce<number | null>(
      (earliest, boundary) =>
        earliest === null ? boundary : Math.min(earliest, boundary),
      null
    )
  };
}
