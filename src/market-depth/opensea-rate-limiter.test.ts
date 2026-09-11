import { getRedisClient } from '@/redis';
import { Time } from '@/time';
import { fetchOpenSeaPricePage } from '@/marketStatsLoop/opensea-price-fetch';
import { OpenSeaClient } from './opensea-client';
import { OpenSeaRateLimiter } from './opensea-rate-limiter';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

describe('shared OpenSea request pacing', () => {
  const originalLimit = process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;

  beforeEach(() => {
    jest.mocked(getRedisClient).mockReturnValue(null);
    delete process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalLimit === undefined) {
      delete process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;
    } else {
      process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE = originalLimit;
    }
  });

  it.each([
    [undefined, 1000],
    ['120', 500],
    ['invalid', 1000]
  ])('paces requests without Redis at limit %s', async (limit, interval) => {
    if (limit !== undefined)
      process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE = limit;
    let now = 1000;
    const sleep = jest.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const limiter = new OpenSeaRateLimiter({ now: () => now, sleep });

    await limiter.acquire(10_000);
    expect(sleep).not.toHaveBeenCalled();
    await limiter.acquire(10_000);
    expect(sleep).toHaveBeenCalledWith(interval);
    await expect(limiter.acquire(now + 100)).rejects.toThrow(
      'deadline exceeded'
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('uses the same Redis quota for market-depth and legacy price requests', async () => {
    const acquire = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1000)
      .mockResolvedValue(0);
    jest
      .mocked(getRedisClient)
      .mockReturnValue({ eval: acquire } as unknown as ReturnType<
        typeof getRedisClient
      >);
    let now = Date.now();
    const sleep = jest.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => Response.json({ offers: [] }));
    const client = new OpenSeaClient({
      apiKey: 'fixture-key',
      sleep,
      now: () => now
    });
    const deadlineMs = now + 10_000;

    await client.getAllOffers('fixture', deadlineMs);
    await fetchOpenSeaPricePage(
      'https://api.opensea.io/api/v2/offers/collection/fixture/all',
      deadlineMs,
      new OpenSeaRateLimiter({ sleep, now: () => now })
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(acquire).toHaveBeenCalledTimes(3);
    for (const call of acquire.mock.calls) {
      expect(call[1].keys).toEqual(['opensea:market-depth:requests']);
      expect(call[1].arguments[2]).toBe('60');
    }
  });

  it('reacquires quota for retries while honoring Retry-After', async () => {
    const acquire = jest.fn().mockResolvedValue(0);
    jest
      .mocked(getRedisClient)
      .mockReturnValue({ eval: acquire } as unknown as ReturnType<
        typeof getRedisClient
      >);
    const sleep = jest.spyOn(Time.prototype, 'sleep').mockResolvedValue();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('throttled', {
          status: 429,
          headers: { 'Retry-After': '7' }
        })
      )
      .mockResolvedValueOnce(Response.json({ offers: [] }));

    await expect(
      fetchOpenSeaPricePage(
        'https://api.opensea.io/api/v2/offers/collection/fixture/all',
        Date.now() + 10_000
      )
    ).resolves.toEqual({ offers: [] });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.mock.contexts[0].toMillis()).toBe(7000);
  });
});
