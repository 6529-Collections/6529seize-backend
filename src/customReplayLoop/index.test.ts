const doInDbContext = jest.fn();
const run = jest.fn();

jest.mock('../secrets', () => ({
  doInDbContext: (fn: () => Promise<unknown>, opts: unknown) =>
    doInDbContext(fn, opts)
}));
jest.mock('@/rep-ratings-removal/rep-ratings-removal', () => ({
  repRatingsRemovalJob: { run: (...args: unknown[]) => run(...args) }
}));

import { handler } from './index';

const lambdaContext = { getRemainingTimeInMillis: () => 123_000 } as any;

function invoke(event: unknown) {
  return handler(event, lambdaContext, () => undefined);
}

describe('customReplayLoop handler', () => {
  beforeEach(() => {
    doInDbContext.mockReset().mockImplementation((fn) => fn());
    run.mockReset().mockResolvedValue({ complete: true });
  });

  it('does nothing without a job', async () => {
    await expect(invoke({})).resolves.toBeUndefined();
    await expect(invoke(undefined)).resolves.toBeUndefined();
    expect(doInDbContext).not.toHaveBeenCalled();
  });

  it('refuses an unknown job', async () => {
    await expect(invoke({ job: 'SOMETHING_ELSE' })).rejects.toThrow(
      'Unknown custom replay job "SOMETHING_ELSE"'
    );
    expect(doInDbContext).not.toHaveBeenCalled();
  });

  it('refuses a bad removal payload before connecting to the database', async () => {
    await expect(
      invoke({ job: 'REP_RATINGS_REMOVE', mode: 'DRY_RUN' })
    ).rejects.toThrow('rater_profile_id');
    expect(doInDbContext).not.toHaveBeenCalled();
  });

  it('runs the removal job with the invocation time left', async () => {
    const result = await invoke({
      job: 'REP_RATINGS_REMOVE',
      mode: 'DRY_RUN',
      rater_profile_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      categories: ['Tag Alpha']
    });

    expect(result).toEqual({ complete: true });
    expect(doInDbContext).toHaveBeenCalledTimes(1);
    const [request, limits] = run.mock.calls[0];
    expect(request).toMatchObject({
      mode: 'DRY_RUN',
      rater: { profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' },
      categories: ['Tag Alpha']
    });
    expect(limits.remainingMillis()).toBe(123_000);
  });
});
