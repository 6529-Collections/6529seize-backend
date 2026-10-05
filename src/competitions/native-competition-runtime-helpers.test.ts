import fc from 'fast-check';
import {
  nativeAwardsForRank,
  nativeThresholdSince,
  nextNativeDecision,
  reducedNativeVotes,
  flooredWeightedNativeVote,
  weightedNativeVote
} from './native-competition-runtime.helpers';
import { CompetitionDecisionConfig } from './competition.types';

const config: CompetitionDecisionConfig = {
  strategy: {
    first_decision_time: 1000,
    subsequent_decisions: [100, 200],
    is_rolling: false
  },
  next_decision_time: 1000,
  time_lock_ms: null,
  max_winners: null,
  winning_min_threshold: null,
  winning_max_threshold: null,
  winning_threshold_min_duration_ms: 0
};

describe('native runtime numerical rules', () => {
  it('floors exact signed weighted ratings before converting large rationals to numbers', () => {
    const max = Number.MAX_SAFE_INTEGER - 1;
    const points = [
      { timestamp: 0, vote: max, sequence: 1 },
      { timestamp: 1, vote: max - 1, sequence: 2 }
    ];
    expect(flooredWeightedNativeVote(points, 2, 2)).toBe(max - 1);
    expect(
      flooredWeightedNativeVote(
        points.map((point) => ({ ...point, vote: -point.vote })),
        2,
        2
      )
    ).toBe(-max);
    expect(flooredWeightedNativeVote(points, 1_000_000, 2)).toBe(max - 1);
    expect(
      flooredWeightedNativeVote(
        [{ timestamp: 0, vote: max, sequence: 1 }],
        1_000_000,
        2
      )
    ).toBe(max);
  });

  it('compares large exact threshold rationals and rounds a crossing up only after integer division', () => {
    const max = Number.MAX_SAFE_INTEGER - 1;
    const points = [
      { timestamp: 0, vote: max - 1, sequence: 1 },
      { timestamp: 1, vote: max, sequence: 2 }
    ];
    expect(nativeThresholdSince(points, 2, 2, max, 0)).toBeNull();
    expect(nativeThresholdSince(points, 3, 2, max, 0)).toBe(3);
  });

  it('integrates whole windows, past values, same-millisecond edits and negative values', () => {
    const points = [
      { timestamp: 0, vote: 20, sequence: 1 },
      { timestamp: 25, vote: 60, sequence: 2 },
      { timestamp: 25, vote: 40, sequence: 3 },
      { timestamp: 75, vote: -20, sequence: 4 },
      { timestamp: 150, vote: 1000, sequence: 5 }
    ];
    expect(weightedNativeVote(points, 100, 100)).toBe(20);
    expect(weightedNativeVote(points, 100, 0)).toBe(-20);
    expect(weightedNativeVote(points, 20, 20)).toBe(20);
    expect(weightedNativeVote([], 100, 100)).toBe(0);
  });

  it('equals direct integer-time integration for arbitrary signed vote histories', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            timestamp: fc.integer({ min: 0, max: 100 }),
            vote: fc.integer({ min: -1000, max: 1000 })
          }),
          { maxLength: 30 }
        ),
        (raw) => {
          const points = raw
            .map((point, sequence) => ({ ...point, sequence }))
            .sort(
              (a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence
            );
          let integral = 0;
          for (let t = 0; t < 100; t++)
            integral +=
              points.filter((point) => point.timestamp <= t).at(-1)?.vote ?? 0;
          expect(weightedNativeVote(points, 100, 100)).toBe(integral / 100);
          expect(flooredWeightedNativeVote(points, 100, 100)).toBe(
            Math.floor(integral / 100)
          );
        }
      )
    );
  });

  it('locates linear threshold crossings and resets after an invisible between-snapshot dip', () => {
    const points = [
      { timestamp: 0, vote: 100, sequence: 1 },
      { timestamp: 100, vote: 0, sequence: 2 },
      { timestamp: 180, vote: 100, sequence: 3 }
    ];
    expect(nativeThresholdSince(points, 100, 100, 50, 0)).toBe(50);
    expect(nativeThresholdSince(points, 260, 100, 50, 0)).toBe(230);
    expect(nativeThresholdSince(points, 190, 100, 50, 0)).toBeNull();
    expect(nativeThresholdSince(points, 260, 0, 50, 0)).toBe(180);
  });

  it('replays finite and rolling schedules without depending on polling times', () => {
    expect(
      [null, 1000, 1100, 1300].map((time) => nextNativeDecision(config, time))
    ).toEqual([1000, 1100, 1300, null]);
    const rolling = {
      ...config,
      strategy: { ...config.strategy, is_rolling: true }
    };
    expect(nextNativeDecision(rolling, 1300)).toBe(1400);
    expect(nextNativeDecision(rolling, 1_000_000_000)).toBeGreaterThan(
      1_000_000_000
    );
    expect(() =>
      nextNativeDecision(
        {
          ...config,
          strategy: { ...config.strategy, subsequent_decisions: [0] }
        },
        1000
      )
    ).toThrow('schedule');
  });

  it('preserves singleton and percentage prize descriptors without inventing credit grants', () => {
    const outcomes = [
      { type: 'MANUAL', description: 'Top prize', amount: 100 },
      {
        type: 'AUTOMATIC',
        subtype: 'CREDIT',
        credit: 'REP',
        rep_category: 'Art',
        description: 'Split',
        amount: 101,
        distribution: [{ amount: 60 }, { amount: 40, description: 'Second' }]
      }
    ];
    expect(
      nativeAwardsForRank(outcomes, 1).map((award) => award.amount)
    ).toEqual([100, 60]);
    expect(nativeAwardsForRank(outcomes, 2)).toEqual([
      expect.objectContaining({
        outcome_position: 1,
        amount: 40,
        description: 'Split / Second',
        credit: 'REP'
      })
    ]);
    expect(nativeAwardsForRank(outcomes, 3)).toEqual([]);
  });

  it('reconciles independent per-entry budgets and never overspends signed shared budgets', () => {
    expect(
      reducedNativeVotes(
        [
          { entryId: 'a', value: -8 },
          { entryId: 'b', value: 8 }
        ],
        5,
        'DROP'
      )
    ).toEqual([
      { entryId: 'a', value: -5 },
      { entryId: 'b', value: 5 }
    ]);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        (values, available) => {
          const votes = values.map((value, index) => ({
            entryId: String(index),
            value
          }));
          const result = reducedNativeVotes(votes, available, 'WAVE');
          expect(
            result.reduce((sum, vote) => sum + Math.abs(vote.value), 0)
          ).toBeLessThanOrEqual(available);
        }
      )
    );
  });
});
