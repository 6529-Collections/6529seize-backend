import { MemeCalendarScheduleProvider } from './meme-calendar-schedule.provider';

describe('MemeCalendarScheduleProvider', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...previousEnv,
      SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON: '3',
      SUBSCRIPTION_COVERAGE_SCHEDULE_TTL_MS: '1000'
    };
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it('loads a bounded projected schedule once per TTL', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      const tokenId = url.endsWith('/next')
        ? 527
        : Number(url.split('/').at(-1));
      return {
        ok: true,
        json: async () => ({
          mint_number: tokenId,
          mint_start: `2026-07-${String(27 + (tokenId - 527)).padStart(2, '0')}T14:40:00.000Z`,
          status: 'upcoming'
        })
      } as Response;
    });
    const provider = new MemeCalendarScheduleProvider(
      fetchImpl as unknown as typeof fetch,
      () => 100
    );

    const first = await provider.getSchedule();
    const second = await provider.getSchedule();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      basis: 'PROJECTED',
      deadlineBasis: 'UNAVAILABLE',
      horizon: 3,
      truncated: true
    });
    expect(first.drops).toHaveLength(3);
    expect(first.drops[0]).toEqual({
      tokenId: 527,
      mintAt: '2026-07-27T14:40:00.000Z',
      topUpDeadline: null
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed calendar data', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ mint_number: 527 })
    })) as unknown as typeof fetch;
    const provider = new MemeCalendarScheduleProvider(fetchImpl, () => 100);

    await expect(provider.getSchedule()).rejects.toThrow(
      'invalid mint response'
    );
  });

  it('uses the environment-matching calendar host by default', async () => {
    delete process.env.SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL;
    process.env.SENTRY_ENVIRONMENT =
      'subscriptionCoverageReconciliationLoop_staging';
    process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = '1';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        mint_number: 527,
        mint_start: '2026-07-27T14:40:00.000Z',
        status: 'upcoming'
      })
    })) as unknown as typeof fetch;
    const provider = new MemeCalendarScheduleProvider(fetchImpl, () => 100);

    await provider.getSchedule();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://staging.6529.io/api/meme-calendar/next',
      expect.any(Object)
    );
  });

  it('excludes live drops from the future forecast horizon', async () => {
    process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = '2';
    const fetchImpl = jest.fn(async (url: string) => {
      const tokenId = url.endsWith('/next')
        ? 527
        : Number(url.split('/').at(-1));
      return {
        ok: true,
        json: async () => ({
          mint_number: tokenId,
          mint_start:
            tokenId === 527
              ? '2026-07-26T14:40:00.000Z'
              : '2026-07-29T14:40:00.000Z',
          status: tokenId === 527 ? 'live' : 'upcoming'
        })
      } as Response;
    });
    const provider = new MemeCalendarScheduleProvider(
      fetchImpl as unknown as typeof fetch,
      () => Date.parse('2026-07-26T15:00:00.000Z')
    );

    const schedule = await provider.getSchedule();

    expect(schedule.drops).toEqual([
      {
        tokenId: 528,
        mintAt: '2026-07-29T14:40:00.000Z',
        topUpDeadline: null
      }
    ]);
    expect(schedule.truncated).toBe(true);
  });
});
