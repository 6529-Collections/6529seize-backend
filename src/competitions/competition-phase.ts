import { CompetitionLifecycle } from '@/entities/ICompetition';
import {
  Competition,
  CompetitionComputedPhase
} from '@/competitions/competition.types';

type PhaseInput = Pick<
  Competition,
  'lifecycle' | 'participation' | 'voting' | 'decisions'
>;

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
  const firstStart = [participationStart, votingStart]
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
    .at(0);
  if (firstStart !== undefined && now < firstStart) {
    return CompetitionComputedPhase.UPCOMING;
  }
  if (
    (participationStart === null || now >= participationStart) &&
    (competition.participation.ends_at === null ||
      now < competition.participation.ends_at)
  ) {
    return CompetitionComputedPhase.PARTICIPATION_OPEN;
  }
  if (
    (votingStart === null || now >= votingStart) &&
    (competition.voting.ends_at === null || now < competition.voting.ends_at)
  ) {
    return CompetitionComputedPhase.VOTING_OPEN;
  }
  if (competition.decisions.next_decision_time !== null) {
    return CompetitionComputedPhase.DECIDING;
  }
  return CompetitionComputedPhase.COMPLETED;
}
