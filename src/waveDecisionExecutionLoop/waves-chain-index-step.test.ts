import {
  indexChainWavesBestEffort,
  WAVES_CHAIN_INDEX_BUDGET_MS,
  wavesChainIndexBudgetMs
} from './waves-chain-index-step';

jest.mock('@/waves-chain-index/waves-chain-index.service', () => ({
  wavesChainIndex: { run: jest.fn() }
}));

describe('the waves chain index step', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it('takes its share, never past the safety margin', () => {
    expect(wavesChainIndexBudgetMs(undefined, {})).toBe(
      WAVES_CHAIN_INDEX_BUDGET_MS
    );
    expect(wavesChainIndexBudgetMs(600_000, {})).toBe(40_000);
    expect(wavesChainIndexBudgetMs(50_000, {})).toBe(20_000);
    expect(wavesChainIndexBudgetMs(10_000, {})).toBe(0);
    expect(
      wavesChainIndexBudgetMs(600_000, { WAVES_CHAIN_INDEX_BUDGET_MS: '90000' })
    ).toBe(90_000);
    expect(
      wavesChainIndexBudgetMs(600_000, { WAVES_CHAIN_INDEX_BUDGET_MS: 'x' })
    ).toBe(40_000);
  });

  it('runs only with FEATURE_WAVES_CHAIN_INDEX, and never fails the loop', async () => {
    const index = { run: jest.fn().mockResolvedValue({ mode: 'indexed' }) };
    process.env = { ...env, FEATURE_WAVES_CHAIN_INDEX: 'false' };
    await indexChainWavesBestEffort(600_000, index);
    expect(index.run).not.toHaveBeenCalled();

    process.env = { ...env, FEATURE_WAVES_CHAIN_INDEX: 'true' };
    await indexChainWavesBestEffort(600_000, index);
    expect(index.run).toHaveBeenCalledWith({ budgetMs: 40_000 });

    index.run.mockClear();
    await indexChainWavesBestEffort(10_000, index);
    expect(index.run).not.toHaveBeenCalled();

    index.run.mockRejectedValueOnce(new Error('gateway down'));
    await expect(
      indexChainWavesBestEffort(600_000, index)
    ).resolves.toBeUndefined();
  });
});
