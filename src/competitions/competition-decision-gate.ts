import { CompetitionType } from '@/entities/ICompetition';
import {
  Competition,
  CompetitionPause
} from '@/competitions/competition.types';
import { nextNativeDecision } from '@/competitions/native-competition-runtime.helpers';

function pausedThrough(
  pauses: readonly CompetitionPause[],
  occurrence: number
): number | null {
  let end: number | null = null;
  for (const pause of pauses) {
    const pauseEnd = pause.end_time ?? Number.POSITIVE_INFINITY;
    if (pause.start_time <= occurrence && occurrence <= pauseEnd) {
      end = Math.max(end ?? occurrence, pauseEnd);
    }
  }
  return end;
}

/** A skipped pause must not block commands while the worker catches up. */
export function isCompetitionDecisionPending(
  competition: Pick<Competition, 'type' | 'decisions' | 'decision_pauses'>,
  now: number
): boolean {
  let next = competition.decisions.next_decision_time;
  if (next === null || next >= now) return false;
  if (competition.type !== CompetitionType.RANK) return true;
  const pauses = competition.decision_pauses ?? [];
  // Each jump passes the end of at least one pause. Work is bounded by pause
  // count, even when a rolling schedule has millions of overdue occurrences.
  for (let skipped = 0; skipped < pauses.length; skipped++) {
    const end = pausedThrough(pauses, next);
    if (end === null) return true;
    const previous = next;
    next = nextNativeDecision(competition.decisions, Math.min(end, now - 1));
    // The final skipped occurrence will end the competition in the worker.
    if (next === null || next <= previous || !Number.isSafeInteger(next))
      return true;
    if (next >= now) return false;
  }
  return true;
}
