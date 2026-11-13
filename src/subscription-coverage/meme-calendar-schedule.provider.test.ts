import { MemeCalendarScheduleProvider } from './meme-calendar-schedule.provider';

describe('MemeCalendarScheduleProvider', () => {
  const previousEnv = process.env;
  let now: number;
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetchSpy = jest
    .fn()
    .mockRejectedValue(new Error('Network unavailable'));

  beforeEach(() => {
    process.env = {
      ...previousEnv,
      SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON: '3',
      SUBSCRIPTION_COVERAGE_SCHEDULE_TTL_MS: '1000'
    };
    now = Date.parse('2026-10-19T10:00:00Z');
    fetchSpy.mockClear();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchSpy
    });
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    if (originalFetch)
      Object.defineProperty(globalThis, 'fetch', originalFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
    process.env = previousEnv;
  });

  it('calculates a bounded projected schedule locally and caches it for the TTL', async () => {
    const provider = new MemeCalendarScheduleProvider(() => now);
    const first = await provider.getSchedule();
    expect(await provider.getSchedule()).toBe(first);
    expect(first).toMatchObject({
      basis: 'PROJECTED',
      deadlineBasis: 'UNAVAILABLE',
      horizon: 3,
      truncated: true,
      fetchedAt: '2026-10-19T10:00:00.000Z'
    });
    expect(first.drops.map(({ mintAt }) => mintAt)).toEqual([
      '2026-10-19T14:40:00.000Z',
      '2026-10-21T14:40:00.000Z',
      '2026-10-23T14:40:00.000Z'
    ]);
    expect(
      first.drops.every(({ topUpDeadline }) => topUpDeadline === null)
    ).toBe(true);
    now += 1000;
    const refreshed = await provider.getSchedule();
    expect(refreshed).not.toBe(first);
    expect(refreshed.drops).toEqual(first.drops);
  });

  it('caps the configured horizon at 60', async () => {
    process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = '1000';
    const schedule = await new MemeCalendarScheduleProvider(
      () => now
    ).getSchedule();
    expect(schedule.horizon).toBe(60);
    expect(schedule.drops).toHaveLength(60);
  });

  it.each([undefined, '0', '-1', '1.5', '3junk'])(
    'defaults an invalid horizon %s to 24',
    async (value) => {
      if (value === undefined)
        delete process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON;
      else process.env.SUBSCRIPTION_COVERAGE_SCHEDULE_HORIZON = value;
      const schedule = await new MemeCalendarScheduleProvider(
        () => now
      ).getSchedule();
      expect(schedule.horizon).toBe(24);
      expect(schedule.drops).toHaveLength(24);
    }
  );

  it('expires the cache at mint start and backfills the full future horizon', async () => {
    now = Date.parse('2026-10-19T14:39:59.999Z');
    const provider = new MemeCalendarScheduleProvider(() => now);
    const first = await provider.getSchedule();
    now += 1;
    const second = await provider.getSchedule();
    expect(second).not.toBe(first);
    expect(second.drops).toHaveLength(3);
    expect(second.drops[0]!.tokenId).toBe(first.drops[0]!.tokenId + 1);
    expect(second.drops.map(({ mintAt }) => mintAt)).toEqual([
      '2026-10-21T14:40:00.000Z',
      '2026-10-23T14:40:00.000Z',
      '2026-10-26T15:40:00.000Z'
    ]);
  });

  it.each([
    [
      '2026-03-27T10:00:00Z',
      [
        '2026-03-27T15:40:00.000Z',
        '2026-03-30T14:40:00.000Z',
        '2026-04-01T14:40:00.000Z'
      ]
    ],
    [
      '2026-12-31T10:00:00Z',
      [
        '2027-01-01T15:40:00.000Z',
        '2027-01-04T15:40:00.000Z',
        '2027-01-06T15:40:00.000Z'
      ]
    ],
    [
      '2028-02-28T10:00:00Z',
      [
        '2028-02-28T15:40:00.000Z',
        '2028-03-01T15:40:00.000Z',
        '2028-03-03T15:40:00.000Z'
      ]
    ],
    [
      '2025-10-20T10:00:00Z',
      [
        '2025-10-21T14:40:00.000Z',
        '2025-10-22T14:40:00.000Z',
        '2025-10-24T14:40:00.000Z'
      ]
    ]
  ])(
    'projects dates across calendar boundaries from %s',
    async (clock, expected) => {
      now = Date.parse(clock);
      const schedule = await new MemeCalendarScheduleProvider(
        () => now
      ).getSchedule();
      expect(schedule.drops.map(({ mintAt }) => mintAt)).toEqual(expected);
    }
  );

  it('does not require a calendar environment or host', async () => {
    delete process.env.NODE_ENV;
    delete process.env.SUBSCRIPTION_COVERAGE_ENVIRONMENT;
    process.env.SUBSCRIPTION_COVERAGE_CALENDAR_BASE_URL =
      'https://unavailable.invalid';
    expect(
      (await new MemeCalendarScheduleProvider(() => now).getSchedule()).drops
    ).toHaveLength(3);
  });

  it('invalidates cached projections if the clock moves backwards', async () => {
    const provider = new MemeCalendarScheduleProvider(() => now);
    const first = await provider.getSchedule();
    now -= 1000;
    expect(await provider.getSchedule()).not.toBe(first);
  });

  it('rejects an invalid clock instead of inventing a schedule', async () => {
    await expect(
      new MemeCalendarScheduleProvider(() => Number.NaN).getSchedule()
    ).rejects.toThrow('Invalid calendar time');
  });
});
