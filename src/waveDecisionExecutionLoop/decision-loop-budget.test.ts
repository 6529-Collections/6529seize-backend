import {
  DECISION_LOOP_BUDGET_DEFAULTS,
  DECISION_LOOP_SAFETY_MARGIN_MS,
  decisionLoopBudget,
  finalDispatchBudgetMs
} from './decision-loop-budget';

describe('decisionLoopBudget', () => {
  it('defaults to 60 s delivery first, a 5 min pass and a 2 min deadline per competition', () => {
    expect(decisionLoopBudget({})).toEqual({
      dispatchFirstMs: 60_000,
      decisionsBudgetMs: 300_000,
      competitionDeadlineMs: 120_000,
      reserveMillis: 300_000
    });
  });

  it('fits the defaults inside the 15 minute invocation', () => {
    const { dispatchFirstMs, decisionsBudgetMs, reserveMillis } =
      DECISION_LOOP_BUDGET_DEFAULTS;
    expect(dispatchFirstMs + decisionsBudgetMs + reserveMillis).toBeLessThan(
      15 * 60_000
    );
  });

  it('reads positive whole milliseconds and ignores anything else', () => {
    expect(
      decisionLoopBudget({
        WAVE_DECISION_LOOP_DISPATCH_FIRST_MS: '30000',
        WAVE_DECISION_LOOP_DECISIONS_BUDGET_MS: 'soon',
        WAVE_DECISION_LOOP_COMPETITION_DEADLINE_MS: '-5'
      })
    ).toEqual({
      ...DECISION_LOOP_BUDGET_DEFAULTS,
      dispatchFirstMs: 30_000
    });
  });
});

describe('finalDispatchBudgetMs', () => {
  it('leaves the dispatcher its own cap when the remaining time is unknown', () => {
    expect(finalDispatchBudgetMs(undefined)).toBeUndefined();
  });

  it.each([
    [400_000, 370_000],
    [30_001, 1],
    [30_000, 0],
    [29_999, 0],
    [0, 0],
    [-5, 0]
  ])(
    'grants %s ms remaining at most what is left before the margin (%s)',
    (remaining, expected) => {
      expect(finalDispatchBudgetMs(remaining)).toBe(expected);
    }
  );

  it('never grants more than the time left before the safety margin', () => {
    for (let remaining = -1_000; remaining <= 1_000_000; remaining += 997) {
      const budget = finalDispatchBudgetMs(remaining)!;
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThanOrEqual(
        Math.max(0, remaining - DECISION_LOOP_SAFETY_MARGIN_MS)
      );
    }
  });
});
