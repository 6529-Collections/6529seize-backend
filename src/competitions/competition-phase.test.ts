import { computeCompetitionPhase } from '@/competitions/competition-phase';
import { CompetitionComputedPhase } from '@/competitions/competition.types';
import { CompetitionLifecycle } from '@/entities/ICompetition';

function input(overrides: Record<string, unknown> = {}) {
  return {
    lifecycle: CompetitionLifecycle.PUBLISHED,
    participation: { starts_at: 100, ends_at: 200 },
    voting: { starts_at: 200, ends_at: 300 },
    decisions: { next_decision_time: 400 },
    ...overrides
  } as Parameters<typeof computeCompetitionPhase>[0];
}

describe('computeCompetitionPhase', () => {
  it.each([
    [CompetitionLifecycle.DRAFT, CompetitionComputedPhase.DRAFT],
    [CompetitionLifecycle.CANCELLED, CompetitionComputedPhase.CANCELLED],
    [CompetitionLifecycle.ARCHIVED, CompetitionComputedPhase.ARCHIVED],
    [CompetitionLifecycle.ENDED, CompetitionComputedPhase.COMPLETED]
  ])('maps stored lifecycle %s', (lifecycle, expected) => {
    expect(computeCompetitionPhase(input({ lifecycle }), 150)).toBe(expected);
  });

  it('derives upcoming, participation, voting, deciding and complete', () => {
    expect(computeCompetitionPhase(input(), 50)).toBe(
      CompetitionComputedPhase.UPCOMING
    );
    expect(computeCompetitionPhase(input(), 150)).toBe(
      CompetitionComputedPhase.PARTICIPATION_OPEN
    );
    expect(computeCompetitionPhase(input(), 250)).toBe(
      CompetitionComputedPhase.VOTING_OPEN
    );
    expect(computeCompetitionPhase(input(), 350)).toBe(
      CompetitionComputedPhase.DECIDING
    );
    expect(
      computeCompetitionPhase(
        input({ decisions: { next_decision_time: null } }),
        350
      )
    ).toBe(CompetitionComputedPhase.COMPLETED);
  });
});
