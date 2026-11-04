import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient } from 'redis';
import { getRedisClient } from '@/redis';
import {
  OpenSeaDeadlineError,
  OpenSeaRateLimiter
} from './opensea-rate-limiter';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

describe('OpenSea distributed request coordination', () => {
  let container: StartedTestContainer;
  let redis: ReturnType<typeof createClient>;
  let now: number;
  const keys = [
    'opensea:market-depth:requests',
    'opensea:market-depth:next-request',
    'opensea:market-depth:cooldown'
  ];
  const originalLimit = process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7.4.5-alpine')
      .withExposedPorts(6379)
      .start();
    redis = createClient({
      url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`
    });
    await redis.connect();
  }, 120000);

  beforeEach(async () => {
    now = 1000;
    delete process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;
    jest
      .mocked(getRedisClient)
      .mockReturnValue(redis as ReturnType<typeof getRedisClient>);
    await redis.del(keys);
  });

  afterAll(async () => {
    await redis?.quit();
    await container?.stop();
    if (originalLimit === undefined)
      delete process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;
    else process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE = originalLimit;
  });

  function worker(
    sleep = async (milliseconds: number) => {
      now += milliseconds;
    }
  ) {
    return new OpenSeaRateLimiter({ now: () => now, sleep });
  }

  it('spaces simultaneous workers instead of granting a burst', async () => {
    await Promise.all([worker().acquire(10000), worker().acquire(10000)]);
    const grants = await redis.zRangeWithScores(keys[0], 0, -1);
    expect(grants.map((grant) => grant.score)).toEqual([1000, 2000]);
  });

  it('honors rolling-window usage recorded by older workers', async () => {
    process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE = '2';
    await redis.zAdd(keys[0], [
      { score: 1000, value: 'old-worker-1' },
      { score: 1001, value: 'old-worker-2' }
    ]);
    now = 2000;
    await worker().acquire(100000);
    expect(now).toBe(61000);
    expect(await redis.zCard(keys[0])).toBe(2);
  });

  it('shares cooldowns and never shortens a longer provider pause', async () => {
    await worker().recordCooldown(7000);
    await worker().recordCooldown(1000);
    const waiting = worker();
    await waiting.acquire(20000);
    expect(now).toBe(8000);
  });

  it('rechecks shared cooldown extensions before granting a waiting worker', async () => {
    const sender = worker();
    await sender.recordCooldown(3000);
    const waits: number[] = [];
    await worker(async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      if (waits.length === 1) await sender.recordCooldown(5000);
    }).acquire(20000);
    expect(waits).toEqual([3000, 5000]);
    expect(now).toBe(9000);
  });

  it('does not grant quota when a provider cooldown exceeds the caller deadline', async () => {
    await worker().recordCooldown(120000);
    await expect(worker().acquire(10000)).rejects.toBeInstanceOf(
      OpenSeaDeadlineError
    );
    expect(await redis.zCard(keys[0])).toBe(0);
  });
});
