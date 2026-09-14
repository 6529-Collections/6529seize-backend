const mockCleanup = jest.fn();
jest.mock('@/secrets', () => ({
  doInDbContext: async (fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } finally {
      mockCleanup();
    }
  }
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('./nft_market_stats', () => ({ findNftMarketStats: jest.fn() }));
jest.mock('./nft_market_stats_nextgen', () => ({
  findNextgenMarketStats: jest.fn()
}));
jest.mock('@/market-depth/opensea-poller', () => ({
  pollOpenSeaMarketDepthForContract: jest.fn()
}));

import { MEMES_CONTRACT } from '@/constants';
import { handler } from './index';
import { findNftMarketStats } from './nft_market_stats';
import { findNextgenMarketStats } from './nft_market_stats_nextgen';
import { pollOpenSeaMarketDepthForContract } from '@/market-depth/opensea-poller';

// The Sentry wrapper is mocked to expose the original async handler.
const invoke = handler as unknown as (
  event: unknown,
  context: { getRemainingTimeInMillis: () => number }
) => Promise<void>;

describe('market refresh scheduling', () => {
  const previousContract = process.env.MARKET_STATS_CONTRACT;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(findNftMarketStats).mockResolvedValue(undefined);
    jest.mocked(findNextgenMarketStats).mockResolvedValue(undefined);
    jest.mocked(pollOpenSeaMarketDepthForContract).mockResolvedValue([]);
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previousContract === undefined)
      delete process.env.MARKET_STATS_CONTRACT;
    else process.env.MARKET_STATS_CONTRACT = previousContract;
  });

  it('allows a legacy refresh longer than four minutes without delaying book capture', async () => {
    process.env.MARKET_STATS_CONTRACT = MEMES_CONTRACT;
    const started = Date.now();
    jest
      .mocked(findNftMarketStats)
      .mockImplementation(async (_contract, deadline) => {
        await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
        expect(Date.now()).toBeLessThan(deadline!);
      });
    const running = invoke({}, { getRemainingTimeInMillis: () => 900_000 });
    expect(findNftMarketStats).toHaveBeenCalledWith(
      MEMES_CONTRACT.toLowerCase(),
      started + 600_000
    );
    expect(pollOpenSeaMarketDepthForContract).toHaveBeenCalledWith(
      MEMES_CONTRACT.toLowerCase(),
      { deadlineMs: started + 780_000 }
    );
    expect(mockCleanup).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(300_000);
    await expect(running).resolves.toBeUndefined();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it.each([MEMES_CONTRACT, 'nextgen'])(
    'awaits the legacy sibling before cleanup when depth fails for %s',
    async (contract) => {
      process.env.MARKET_STATS_CONTRACT = contract;
      let finishLegacy!: () => void;
      const pending = new Promise<void>((resolve) => {
        finishLegacy = resolve;
      });
      jest.mocked(findNftMarketStats).mockReturnValue(pending);
      jest.mocked(findNextgenMarketStats).mockReturnValue(pending);
      jest
        .mocked(pollOpenSeaMarketDepthForContract)
        .mockRejectedValue(new Error('fixture depth failure'));
      const running = invoke({}, { getRemainingTimeInMillis: () => 900_000 });
      const outcome = expect(running).rejects.toThrow('fixture depth failure');
      await jest.advanceTimersByTimeAsync(0);
      expect(mockCleanup).not.toHaveBeenCalled();
      finishLegacy();
      await outcome;
      expect(mockCleanup).toHaveBeenCalledTimes(1);
    }
  );

  it('starts NextGen legacy without waiting for catch-up and awaits depth when legacy fails', async () => {
    process.env.MARKET_STATS_CONTRACT = 'nextgen';
    let finishDepth!: () => void;
    jest.mocked(pollOpenSeaMarketDepthForContract).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDepth = () => resolve([]);
        })
    );
    jest
      .mocked(findNextgenMarketStats)
      .mockRejectedValue(new Error('fixture legacy failure'));
    const started = Date.now();
    const running = invoke({}, { getRemainingTimeInMillis: () => 900_000 });
    const outcome = expect(running).rejects.toThrow('fixture legacy failure');
    await jest.advanceTimersByTimeAsync(0);
    expect(findNextgenMarketStats).toHaveBeenCalledWith(
      expect.any(String),
      started + 600_000
    );
    expect(mockCleanup).not.toHaveBeenCalled();
    finishDepth();
    await outcome;
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });
});
