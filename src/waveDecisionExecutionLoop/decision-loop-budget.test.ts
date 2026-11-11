import {
  DECISION_LOOP_BUDGET_DEFAULTS,
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
  it('leaves a safety margin and always allows a short attempt', () => {
    expect(finalDispatchBudgetMs(undefined)).toBeUndefined();
    expect(finalDispatchBudgetMs(400_000)).toBe(370_000);
    expect(finalDispatchBudgetMs(31_000)).toBe(5_000);
  });
});
