import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient } from 'redis';
import { getRedisClient } from '@/redis';
import {
  OpenSeaDeadlineError,
  OpenSeaRateLimiter
} from './opensea-rate-limiter';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

describe('OpenSea distributed request coordination on Redis Cluster', () => {
  let container: StartedTestContainer;
  let redis: ReturnType<typeof createClient>;
  let now: number;
  const keys = [
    'opensea:market-depth:requests',
    '{opensea:market-depth:requests}:next-request',
    '{opensea:market-depth:requests}:cooldown'
  ];
  const originalLimit = process.env.OPENSEA_SHARED_REQUESTS_PER_MINUTE;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7.4.5-alpine')
      .withCommand([
        'redis-server',
        '--cluster-enabled',
        'yes',
        '--cluster-config-file',
        '/tmp/nodes.conf',
        '--cluster-node-timeout',
        '1000'
      ])
      .withExposedPorts(6379)
      .start();
    redis = createClient({
      url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`
    });
    await redis.connect();
    await redis.sendCommand(['CLUSTER', 'ADDSLOTSRANGE', '0', '16383']);
    for (let attempt = 0; attempt < 50; attempt++) {
      const info = await redis.sendCommand(['CLUSTER', 'INFO']);
      if (String(info).includes('cluster_state:ok')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Redis Cluster fixture did not become ready');
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

  it('enforces cross-slot errors while retaining the legacy quota hash slot', async () => {
    await expect(
      redis.eval('return 0', {
        keys: [keys[0], 'opensea:market-depth:cooldown']
      })
    ).rejects.toThrow('CROSSSLOT');
    const slots = await Promise.all(
      keys.map((key) => redis.sendCommand(['CLUSTER', 'KEYSLOT', key]))
    );
    expect(new Set(slots).size).toBe(1);
    await expect(worker().acquire(10000)).resolves.toBeUndefined();
  });

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

  it('keeps cooldown expiry positive across forward and backward clock skew', async () => {
    await worker().recordCooldown(7000);
    now = 50000;
    await worker().recordCooldown(1000);
    expect(await redis.get(keys[2])).toBe('51000');
    expect(await redis.pTTL(keys[2])).toBeGreaterThan(0);
    now = 1000;
    await worker().recordCooldown(2000);
    expect(await redis.get(keys[2])).toBe('51000');
    expect(await redis.pTTL(keys[2])).toBeGreaterThan(0);
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
