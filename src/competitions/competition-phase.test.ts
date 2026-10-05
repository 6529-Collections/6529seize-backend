import { computeCompetitionPhase } from '@/competitions/competition-phase';
import { CompetitionComputedPhase } from '@/competitions/competition.types';
import {
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';

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
  it('keeps native Approve deciding after voting closes until explicitly ended', () => {
    const native = input({
      storage_mode: CompetitionStorageMode.NATIVE,
      type: CompetitionType.APPROVE,
      decisions: { next_decision_time: null }
    });
    expect(computeCompetitionPhase(native, 300)).toBe(
      CompetitionComputedPhase.VOTING_OPEN
    );
    expect(computeCompetitionPhase(native, 301)).toBe(
      CompetitionComputedPhase.DECIDING
    );
    expect(
      computeCompetitionPhase(
        { ...native, lifecycle: CompetitionLifecycle.ENDED },
        301
      )
    ).toBe(CompetitionComputedPhase.COMPLETED);
  });

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
