import {
  getNftLinkResolutionBudget,
  NftLinkResolutionDeadlineError,
  withNftLinkResolutionBudget
} from '@/nft-links/resolution-budget';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

describe('NFT link resolution budget', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('clears the deadline on success and failure across warm invocations', async () => {
    for (const fail of [false, true]) {
      let signal: AbortSignal | undefined;
      const operation = withNftLinkResolutionBudget(100, async () => {
        signal = getNftLinkResolutionBudget()!.signal;
        if (fail) throw new Error('failed');
        return 'done';
      });
      if (fail) await expect(operation).rejects.toThrow('failed');
      else await expect(operation).resolves.toBe('done');
      expect(signal?.aborted).toBe(true);
      expect(getNftLinkResolutionBudget()).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  it('aborts active work at the total deadline', async () => {
    await withNftLinkResolutionBudget(100, async () => {
      const budget = getNftLinkResolutionBudget()!;
      const onAbort = jest.fn();
      budget.signal.addEventListener('abort', onAbort);
      await jest.advanceTimersByTimeAsync(100);
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(() => budget.check()).toThrow(NftLinkResolutionDeadlineError);
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start a retry wait without enough time for another RPC', async () => {
    await withNftLinkResolutionBudget(12_000, async () => {
      await expect(
        getNftLinkResolutionBudget()!.waitToRetry(10_000)
      ).rejects.toThrow(NftLinkResolutionDeadlineError);
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps overlapping resolution budgets isolated', async () => {
    let finishFirst: (() => void) | undefined;
    const first = withNftLinkResolutionBudget(1000, async () => {
      const budget = getNftLinkResolutionBudget();
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      expect(getNftLinkResolutionBudget()).toBe(budget);
      expect(budget!.signal.aborted).toBe(false);
    });
    await withNftLinkResolutionBudget(50, async () => {
      await jest.advanceTimersByTimeAsync(50);
      expect(getNftLinkResolutionBudget()!.signal.aborted).toBe(true);
    });
    finishFirst!();
    await first;
    expect(jest.getTimerCount()).toBe(0);
  });
});
