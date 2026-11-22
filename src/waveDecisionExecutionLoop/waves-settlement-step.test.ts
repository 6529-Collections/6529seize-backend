import { Logger } from '@/logging';
import { DECISION_LOOP_SAFETY_MARGIN_MS } from './decision-loop-budget';
import {
  sendSettlementsBestEffort,
  WAVES_SETTLEMENT_SENDER_BUDGET_MS,
  wavesSettlementBudgetMs
} from './waves-settlement-step';

const REPORT = {
  due: 1,
  sent: 1,
  waiting: 0,
  refused: 0,
  errors: 0,
  budgetSpent: false
};

describe('waves settlement step', () => {
  const saved = process.env.FEATURE_WAVES_SETTLEMENT_SENDER;
  let error: jest.SpyInstance;

  beforeEach(() => {
    process.env.FEATURE_WAVES_SETTLEMENT_SENDER = 'true';
    jest.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FEATURE_WAVES_SETTLEMENT_SENDER;
    else process.env.FEATURE_WAVES_SETTLEMENT_SENDER = saved;
    jest.restoreAllMocks();
  });

  it('takes its share, or what is left before the safety margin', () => {
    expect(WAVES_SETTLEMENT_SENDER_BUDGET_MS).toBe(20_000);
    expect(wavesSettlementBudgetMs(undefined, {})).toBe(20_000);
    expect(wavesSettlementBudgetMs(600_000, {})).toBe(20_000);
    expect(
      wavesSettlementBudgetMs(DECISION_LOOP_SAFETY_MARGIN_MS + 5_000, {})
    ).toBe(5_000);
    expect(wavesSettlementBudgetMs(DECISION_LOOP_SAFETY_MARGIN_MS, {})).toBe(0);
    expect(wavesSettlementBudgetMs(1_000, {})).toBe(0);
  });

  it('reads its share from the environment, never past the margin', () => {
    const env = { WAVES_SETTLEMENT_SENDER_BUDGET_MS: ' 45000 ' };
    expect(wavesSettlementBudgetMs(undefined, env)).toBe(45_000);
    expect(wavesSettlementBudgetMs(60_000, env)).toBe(30_000);
    for (const raw of ['0', '-5', 'soon', '1.5', '']) {
      expect(
        wavesSettlementBudgetMs(undefined, {
          WAVES_SETTLEMENT_SENDER_BUDGET_MS: raw
        })
      ).toBe(20_000);
    }
  });

  it('does nothing unless the feature is on', async () => {
    process.env.FEATURE_WAVES_SETTLEMENT_SENDER = 'false';
    const run = jest.fn().mockResolvedValue(REPORT);
    await sendSettlementsBestEffort(600_000, { run });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the sender with its budget', async () => {
    const run = jest.fn().mockResolvedValue(REPORT);
    await sendSettlementsBestEffort(600_000, { run });
    expect(run).toHaveBeenCalledWith({ budgetMs: 20_000 });
  });

  it('skips the sender when no time is left', async () => {
    const run = jest.fn().mockResolvedValue(REPORT);
    await sendSettlementsBestEffort(DECISION_LOOP_SAFETY_MARGIN_MS - 1, {
      run
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('never fails the decision loop', async () => {
    const run = jest.fn().mockRejectedValue(new Error('gateway down'));
    await expect(
      sendSettlementsBestEffort(600_000, { run })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('gateway down'));
  });
});
