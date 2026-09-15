import { MemeCalendarScheduleProvider } from './meme-calendar-schedule.provider';

describe('MemeCalendarScheduleProvider', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...previousEnv,
      SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL: 'https://calendar.test',
      SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON: '3',
      SUBSCRIPTION_COVERAGE_SCHEDULE_TTL_MS: '1000',
      SUBSCRIPTION_COVERAGE_SCHEDULE_FAILURE_TTL_MS: '50'
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

  it('caps a misconfigured schedule horizon', async () => {
    process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = '1000';
    const fetchImpl = jest.fn(async (url: string) => {
      const tokenId = url.endsWith('/next')
        ? 527
        : Number(url.split('/').at(-1));
      return {
        ok: true,
        json: async () => ({
          mint_number: tokenId,
          mint_start: new Date(
            Date.UTC(2026, 6, 27) + (tokenId - 527) * 86_400_000
          ).toISOString(),
          status: 'upcoming'
        })
      } as Response;
    });
    const provider = new MemeCalendarScheduleProvider(
      fetchImpl as unknown as typeof fetch,
      () => 100
    );

    const schedule = await provider.getSchedule();

    expect(schedule.horizon).toBe(60);
    expect(schedule.drops).toHaveLength(60);
    expect(fetchImpl).toHaveBeenCalledTimes(60);
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
    process.env.SUBSCRIPTION_COVERAGE_ENVIRONMENT = 'staging';
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

  it('fails closed when no calendar environment is configured', async () => {
    delete process.env.SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL;
    delete process.env.SUBSCRIPTION_COVERAGE_ENVIRONMENT;
    delete process.env.NODE_ENV;
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const provider = new MemeCalendarScheduleProvider(fetchImpl, () => 100);

    await expect(provider.getSchedule()).rejects.toThrow(
      'calendar environment is not configured'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('backfills the future horizon when the next drop is already live', async () => {
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
              : `2026-07-${tokenId - 499}T14:40:00.000Z`,
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
      },
      {
        tokenId: 529,
        mintAt: '2026-07-30T14:40:00.000Z',
        topUpDeadline: null
      }
    ]);
    expect(schedule.truncated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns the contiguous valid prefix when a later token is malformed', async () => {
    process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = '4';
    const fetchImpl = jest.fn(async (url: string) => {
      const tokenId = url.endsWith('/next')
        ? 527
        : Number(url.split('/').at(-1));
      return {
        ok: true,
        json: async () =>
          tokenId === 529
            ? { mint_number: tokenId }
            : {
                mint_number: tokenId,
                mint_start: `2026-07-${tokenId - 500}T14:40:00.000Z`,
                status: 'upcoming'
              }
      } as Response;
    });
    const provider = new MemeCalendarScheduleProvider(
      fetchImpl as unknown as typeof fetch,
      () => 100
    );

    const schedule = await provider.getSchedule();

    expect(schedule.drops.map((drop) => drop.tokenId)).toEqual([527, 528]);
  });

  it('briefly caches calendar failures before retrying', async () => {
    let now = 100;
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 503
    })) as unknown as typeof fetch;
    const provider = new MemeCalendarScheduleProvider(fetchImpl, () => now);

    await expect(provider.getSchedule()).rejects.toThrow('503');
    await expect(provider.getSchedule()).rejects.toThrow('503');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 51;
    await expect(provider.getSchedule()).rejects.toThrow('503');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
