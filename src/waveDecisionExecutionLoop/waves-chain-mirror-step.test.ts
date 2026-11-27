import {
  mirrorChainWavesBestEffort,
  WAVES_CHAIN_MIRROR_BUDGET_MS,
  wavesChainMirrorBudgetMs
} from './waves-chain-mirror-step';

jest.mock('@/waves-chain-mirror/waves-chain-mirror.service', () => ({
  wavesChainMirror: { run: jest.fn() }
}));

describe('the waves chain mirror step', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it('takes its share, never past the safety margin', () => {
    expect(wavesChainMirrorBudgetMs(undefined, {})).toBe(
      WAVES_CHAIN_MIRROR_BUDGET_MS
    );
    expect(wavesChainMirrorBudgetMs(600_000, {})).toBe(25_000);
    expect(wavesChainMirrorBudgetMs(40_000, {})).toBe(10_000);
    expect(wavesChainMirrorBudgetMs(10_000, {})).toBe(0);
    expect(
      wavesChainMirrorBudgetMs(600_000, {
        WAVES_CHAIN_MIRROR_BUDGET_MS: '60000'
      })
    ).toBe(60_000);
    expect(
      wavesChainMirrorBudgetMs(600_000, { WAVES_CHAIN_MIRROR_BUDGET_MS: '-1' })
    ).toBe(25_000);
  });

  it('runs only with FEATURE_WAVES_CHAIN_MIRROR, and never fails the loop', async () => {
    const mirror = { run: jest.fn().mockResolvedValue({ mode: 'report' }) };
    process.env = { ...env, FEATURE_WAVES_CHAIN_MIRROR: undefined };
    await mirrorChainWavesBestEffort(600_000, mirror);
    expect(mirror.run).not.toHaveBeenCalled();

    process.env = { ...env, FEATURE_WAVES_CHAIN_MIRROR: 'true' };
    await mirrorChainWavesBestEffort(600_000, mirror);
    expect(mirror.run).toHaveBeenCalledWith({ budgetMs: 25_000 });

    mirror.run.mockClear();
    await mirrorChainWavesBestEffort(10_000, mirror);
    expect(mirror.run).not.toHaveBeenCalled();

    mirror.run.mockRejectedValueOnce(new Error('database down'));
    await expect(
      mirrorChainWavesBestEffort(600_000, mirror)
    ).resolves.toBeUndefined();
  });
});
