import {
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import type { CompetitionRecord } from '@/competitions/competition.repository';
import type { WaveEntity } from '@/entities/IWave';

export type DefaultCompetitionRecord = Pick<
  CompetitionRecord,
  | 'id'
  | 'storage_mode'
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

function timing(
  record: DefaultCompetitionRecord,
  wave: WaveEntity,
  legacyDecisionsDone: number
) {
  if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER) {
    return {
      starts: [
        date(wave.participation_period_start),
        date(wave.voting_period_start)
      ],
      ends: [date(wave.participation_period_end), date(wave.voting_period_end)],
      pending: wave.next_decision_time !== null,
      inclusiveEnd: false,
      approveDeciding:
        wave.type === 'APPROVE' &&
        (wave.max_winners === null ||
          legacyDecisionsDone < Number(wave.max_winners))
    };
  }
  const pending = nativeDecisionPending(record.decision_config);
  if (pending === null) return null;
  return {
    starts: [
      date(record.participation_starts_at),
      date(record.voting_starts_at)
    ],
    ends: [date(record.participation_ends_at), date(record.voting_ends_at)],
    pending,
    inclusiveEnd: true,
    approveDeciding: record.type === CompetitionType.APPROVE
  };
}

function isEligible(record: DefaultCompetitionRecord): boolean {
  if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER)
    return true;
  return (
    record.published_at !== null &&
    record.lifecycle !== CompetitionLifecycle.DRAFT &&
    record.lifecycle !== CompetitionLifecycle.CANCELLED &&
    !(record.cancelled_at !== null && record.ended_at === null)
  );
}

function completionEnd(
  recordedEnd: number | null,
  scheduledEnd: number | null,
  legacy: boolean,
  approve: boolean,
  lastDecision: number | null
): number | null {
  if (recordedEnd !== null) return recordedEnd;
  if (legacy && approve && lastDecision !== null) return lastDecision;
  if (legacy && scheduledEnd !== null) {
    return Math.max(scheduledEnd, lastDecision ?? scheduledEnd);
  }
  return scheduledEnd;
}

function isCompleted(
  record: DefaultCompetitionRecord,
  legacy: boolean,
  approveQuotaReached: boolean,
  closed: boolean,
  periods: NonNullable<ReturnType<typeof timing>>
): boolean {
  if (!legacy && record.lifecycle === CompetitionLifecycle.ENDED) return true;
  if (!legacy && record.ended_at !== null) return true;
  if (approveQuotaReached) return true;
  return closed && !periods.pending && !periods.approveDeciding;
}

/** Selection-only normalization. Never rewrites legacy primary or execution state. */
export function normalizeDefaultCompetition(
  record: DefaultCompetitionRecord,
  wave: WaveEntity,
  now: number,
  legacyLastDecision: number | null = null,
  legacyDecisionsDone = 0
): SelectionInput | null {
  if (!isEligible(record)) return null;
  const legacy = record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER;
  const periods = timing(record, wave, legacyDecisionsDone);
  // Unknown decision state cannot safely be ranked as active or completed.
  if (!periods) return null;
  // A null start means no lower bound, not creation/publication time.
  const start = periods.starts.includes(null)
    ? null
    : Math.min(...(periods.starts as number[]));
  const finiteEnds = periods.ends.filter(
    (value): value is number => value !== null
  );
  const closed =
    finiteEnds.length === periods.ends.length &&
    finiteEnds.every((end) => (periods.inclusiveEnd ? now > end : now >= end));
  const approve = legacy && wave.type === 'APPROVE';
  const approveQuotaReached =
    approve && !periods.approveDeciding && (start === null || now >= start);
  const completed = isCompleted(
    record,
    legacy,
    approveQuotaReached,
    closed,
    periods
  );
  // Archived history must have evidence of completion; archive time is never an end.
  if (
    !legacy &&
    record.lifecycle === CompetitionLifecycle.ARCHIVED &&
    !completed
  )
    return null;
  if (completed) {
    return {
      id: record.id,
      start,
      end: completionEnd(
        legacy ? null : date(record.ended_at),
        closed ? Math.max(...finiteEnds) : null,
        legacy,
        approve,
        legacyLastDecision
      ),
      phase: 'completed',
      boundaries: []
    };
  }
  return {
    id: record.id,
    start,
    end: null,
    phase: start !== null && now < start ? 'upcoming' : 'active',
    boundaries: [
      ...periods.starts,
      ...periods.ends.map((end) => {
        if (end === null) return null;
        return end + (periods.inclusiveEnd ? 1 : 0);
      })
    ].filter((value): value is number => value !== null && value > now)
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
