import { CompetitionLifecycle, CompetitionType } from '@/entities/ICompetition';
import {
  Competition,
  CompetitionComputedPhase
} from '@/competitions/competition.types';

type PhaseInput = Pick<
  Competition,
  'lifecycle' | 'participation' | 'voting' | 'decisions'
> &
  Partial<Pick<Competition, 'type'>>;

export function computeCompetitionPhase(
  competition: PhaseInput,
  now: number
): CompetitionComputedPhase {
  if (competition.lifecycle === CompetitionLifecycle.DRAFT) {
    return CompetitionComputedPhase.DRAFT;
  }
  if (competition.lifecycle === CompetitionLifecycle.CANCELLED) {
    return CompetitionComputedPhase.CANCELLED;
  }
  if (competition.lifecycle === CompetitionLifecycle.ARCHIVED) {
    return CompetitionComputedPhase.ARCHIVED;
  }
  if (competition.lifecycle === CompetitionLifecycle.ENDED) {
    return CompetitionComputedPhase.COMPLETED;
  }

  const participationStart = competition.participation.starts_at;
  const votingStart = competition.voting.starts_at;
  const withinEnd = (end: number | null) => end === null || now <= end;
  const firstStart = [participationStart, votingStart]
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
    .at(0);
  if (firstStart !== undefined && now < firstStart) {
    return CompetitionComputedPhase.UPCOMING;
  }
  if (
    (participationStart === null || now >= participationStart) &&
    withinEnd(competition.participation.ends_at)
  ) {
    return CompetitionComputedPhase.PARTICIPATION_OPEN;
  }
  if (
    (votingStart === null || now >= votingStart) &&
    withinEnd(competition.voting.ends_at)
  ) {
    return CompetitionComputedPhase.VOTING_OPEN;
  }
  if (
    competition.decisions.next_decision_time !== null ||
    competition.type === CompetitionType.APPROVE
  ) {
    return CompetitionComputedPhase.DECIDING;
  }
  return CompetitionComputedPhase.COMPLETED;
}

/** Finite wire representation for an indefinite pause in permanent old APIs. */
export const INDEFINITE_COMPETITION_PAUSE_END = 253402300799000;
