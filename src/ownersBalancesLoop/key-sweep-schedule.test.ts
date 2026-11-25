import { sweepHoldingsKeys } from '@/holdings/holdings-key-sweep';
import { Time } from '@/time';
import { handler } from './index';
import { updateOwnerBalances } from './owners_balances';

jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('../secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<unknown>) => work())
}));
jest.mock('./owners_balances', () => ({ updateOwnerBalances: jest.fn() }));
jest.mock('@/holdings/holdings-key-sweep', () => ({
  sweepHoldingsKeys: jest.fn(async () => ({ tables: [], sums: null }))
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  retryPendingSubscriptionCacheInvalidations: jest.fn()
}));

const invoke = (event?: unknown) =>
  (handler as unknown as (event: unknown) => Promise<unknown>)(event);
const at = (minute: number) =>
  jest
    .spyOn(Time, 'currentMillis')
    .mockReturnValue(Date.UTC(2026, 10, 25, 1, minute, 20));

describe('ownersBalancesLoop key sweep', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, FEATURE_HOLDINGS_MEMBERSHIP_QUEUE: 'true' };
  });

  afterAll(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it('repairs once an hour, on the scheduled run at minute 0, after the balances', async () => {
    at(0);
    await invoke({ source: 'aws.events' });
    expect(updateOwnerBalances).toHaveBeenCalledTimes(1);
    expect(sweepHoldingsKeys).toHaveBeenCalledWith({ repair: true });
    expect(
      jest.mocked(updateOwnerBalances).mock.invocationCallOrder[0]
    ).toBeLessThan(jest.mocked(sweepHoldingsKeys).mock.invocationCallOrder[0]);
  });

  it('does not sweep on other minutes, or with the flag off', async () => {
    at(15);
    await invoke({ source: 'aws.events' });
    delete process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE;
    at(0);
    await invoke({ source: 'aws.events' });
    expect(updateOwnerBalances).toHaveBeenCalledTimes(2);
    expect(sweepHoldingsKeys).not.toHaveBeenCalled();
  });

  it('sweeps when the run started at minute 0, even if the balances end after it', async () => {
    at(0);
    // The balances pass ends at minute 2.
    jest.mocked(updateOwnerBalances).mockImplementationOnce(async () => {
      at(2);
    });
    await invoke({ source: 'aws.events' });
    expect(sweepHoldingsKeys).toHaveBeenCalledWith({ repair: true });
  });

  it('keeps the balances run when the sweep fails', async () => {
    at(0);
    jest.mocked(sweepHoldingsKeys).mockRejectedValueOnce(new Error('timeout'));
    await expect(invoke({ source: 'aws.events' })).resolves.toBeUndefined();
    expect(updateOwnerBalances).toHaveBeenCalledTimes(1);
  });

  it('runs only the sweep when invoked for it, reporting unless asked to repair', async () => {
    const result = await invoke({ action: 'holdings-key-sweep' });
    expect(updateOwnerBalances).not.toHaveBeenCalled();
    expect(sweepHoldingsKeys).toHaveBeenCalledWith({ repair: false });
    expect(result).toEqual({
      action: 'holdings-key-sweep',
      repair: false,
      tables: [],
      sums: null
    });
  });
});
