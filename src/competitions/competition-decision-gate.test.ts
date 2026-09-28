import { isCompetitionDecisionPending } from '@/competitions/competition-decision-gate';
import {
  Competition,
  CompetitionPause
} from '@/competitions/competition.types';
import { CompetitionType } from '@/entities/ICompetition';

function pause(start: number, end: number | null): CompetitionPause {
  return {
    id: `${start}:${end}`,
    competition_id: 'competition',
    start_time: start,
    end_time: end,
    reason: null
  };
}

function competition(
  pauses: readonly CompetitionPause[],
  rolling = true
): Pick<Competition, 'type' | 'decisions' | 'decision_pauses'> {
  return {
    type: CompetitionType.RANK,
    decisions: {
      strategy: {
        first_decision_time: 10,
        subsequent_decisions: [10, 20],
        is_rolling: rolling
      },
      next_decision_time: 10,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0,
      max_winners: null,
      time_lock_ms: null
    },
    decision_pauses: pauses
  };
}

describe('isCompetitionDecisionPending', () => {
  it('keeps exact occurrence equality open and blocks an overdue unpaused occurrence', () => {
    const scheduled = competition([]);
    expect(isCompetitionDecisionPending(scheduled, 9)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 10)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 11)).toBe(true);
    expect(
      isCompetitionDecisionPending(
        {
          ...scheduled,
          decisions: { ...scheduled.decisions, next_decision_time: null }
        },
        11
      )
    ).toBe(false);
  });

  it('skips occurrences on both inclusive pause boundaries', () => {
    const scheduled = competition([pause(10, 20)]);
    expect(isCompetitionDecisionPending(scheduled, 21)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 40)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 41)).toBe(true);
  });

  it('checks every overdue occurrence even after the first paused occurrence', () => {
    expect(
      isCompetitionDecisionPending(
        competition([pause(10, 10), pause(40, null)]),
        41
      )
    ).toBe(true);
  });

  it('crosses separate pauses when the gap contains no occurrence', () => {
    expect(
      isCompetitionDecisionPending(
        competition([pause(10, 10), pause(20, 20)]),
        21
      )
    ).toBe(false);
  });

  it('starts at stored progress instead of reconsidering old unpaused decisions', () => {
    const scheduled = competition([pause(20, 40)]);
    expect(
      isCompetitionDecisionPending(
        {
          ...scheduled,
          decisions: { ...scheduled.decisions, next_decision_time: 20 }
        },
        41
      )
    ).toBe(false);
  });

  it('keeps the final paused decision closed until the worker ends the competition', () => {
    const scheduled = competition([pause(10, null)], false);
    expect(isCompetitionDecisionPending(scheduled, 21)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 40)).toBe(false);
    expect(isCompetitionDecisionPending(scheduled, 41)).toBe(true);
  });

  it('jumps across a very large rolling backlog without enumerating occurrences', () => {
    expect(
      isCompetitionDecisionPending(
        competition([pause(10, null)]),
        1_000_000_000_000
      )
    ).toBe(false);
  });

  it('does not use a future pause to hide an unpaused overdue decision', () => {
    expect(
      isCompetitionDecisionPending(competition([pause(11, null)]), 41)
    ).toBe(true);
  });

  it('does not exempt another competition type or missing pause data', () => {
    const scheduled = competition([pause(10, null)]);
    expect(
      isCompetitionDecisionPending(
        { ...scheduled, type: CompetitionType.APPROVE },
        11
      )
    ).toBe(true);
    expect(
      isCompetitionDecisionPending(
        { ...scheduled, decision_pauses: undefined },
        11
      )
    ).toBe(true);
  });
});
