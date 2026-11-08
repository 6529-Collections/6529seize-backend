import { GenericContainer, StartedTestContainer } from 'testcontainers';
import {
  evictWaveGroupsEntityCache,
  getRedisClient,
  initRedis,
  WAVE_GROUPS_CACHE_GENERATION_KEY,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
  WAVE_GROUPS_CACHE_STAMP_KEY
} from '@/redis';
import {
  CatalogueStamp,
  RedisWaveGroupsCatalogueStore
} from './wave-groups-catalogue';

// The scripts run against a real Redis: their key handling, Lua nil/false
// replies and the generation check are what this file pins.
let container: StartedTestContainer;
let store: RedisWaveGroupsCatalogueStore;
const env = {
  FORCE_AVOID_REDIS: process.env.FORCE_AVOID_REDIS,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PORT: process.env.REDIS_PORT
};

beforeAll(async () => {
  container = await new GenericContainer('redis:7.4.5-alpine')
    .withExposedPorts(6379)
    .start();
  delete process.env.FORCE_AVOID_REDIS;
  process.env.REDIS_URL = container.getHost();
  process.env.REDIS_PORT = String(container.getMappedPort(6379));
  await initRedis();
  store = new RedisWaveGroupsCatalogueStore(getRedisClient()!);
}, 30_000);

afterAll(async () => {
  await getRedisClient()?.quit();
  await container?.stop();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  await getRedisClient()!.del([
    WAVE_GROUPS_CACHE_KEY,
    WAVE_GROUPS_CACHE_STAMP_KEY,
    WAVE_GROUPS_CACHE_GENERATION_KEY,
    WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY
  ]);
});

function stamp(payload: string, generation: string): CatalogueStamp {
  return {
    generation,
    hash: `hash-of-${payload}`,
    bytes: Buffer.byteLength(payload, 'utf8'),
    publishedAt: 1_000
  };
}

it('probes an empty cache as missing, unstamped, generation 0', async () => {
  await expect(store.probe()).resolves.toEqual({
    bytes: 0,
    stamp: null,
    generation: '0'
  });
});

it('publishes the blob with its stamp and releases the lease', async () => {
  const token = await store.acquireRebuildLease();
  expect(token).not.toBeNull();
  await expect(store.acquireRebuildLease()).resolves.toBeNull();
  const payload = JSON.stringify([{ id: 'g1' }]);

  await expect(
    store.publish({
      payload,
      stamp: stamp(payload, '0'),
      ttlSec: 60,
      leaseToken: token
    })
  ).resolves.toBe(true);

  await expect(store.probe()).resolves.toEqual({
    bytes: Buffer.byteLength(payload, 'utf8'),
    stamp: stamp(payload, '0'),
    generation: '0'
  });
  await expect(store.readBlob()).resolves.toBe(payload);
  await expect(
    getRedisClient()!.pTTL(WAVE_GROUPS_CACHE_STAMP_KEY)
  ).resolves.toBeGreaterThan(59_000);
  await expect(store.acquireRebuildLease()).resolves.not.toBeNull();
});

it('an eviction deletes blob and stamp and blocks a rebuild loaded before it', async () => {
  const payload = JSON.stringify([{ id: 'g1' }]);
  await store.publish({
    payload,
    stamp: stamp(payload, '0'),
    ttlSec: 60,
    leaseToken: null
  });

  await evictWaveGroupsEntityCache();

  await expect(store.probe()).resolves.toEqual({
    bytes: 0,
    stamp: null,
    generation: '1'
  });
  // A rebuild that read generation 0 before the eviction cannot publish.
  await expect(
    store.publish({
      payload,
      stamp: stamp(payload, '0'),
      ttlSec: 60,
      leaseToken: null
    })
  ).resolves.toBe(false);
  await expect(store.readBlob()).resolves.toBeNull();
});

it('releases only its own lease', async () => {
  const token = (await store.acquireRebuildLease())!;
  await store.releaseRebuildLease('someone-else');
  await expect(store.acquireRebuildLease()).resolves.toBeNull();
  await store.releaseRebuildLease(token);
  await expect(store.acquireRebuildLease()).resolves.not.toBeNull();
});

it('expires blob and stamp together and keeps the generation', async () => {
  const payload = JSON.stringify([{ id: 'g1' }]);
  await evictWaveGroupsEntityCache();
  await store.publish({
    payload,
    stamp: stamp(payload, '1'),
    ttlSec: 1,
    leaseToken: null
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await expect(store.probe()).resolves.toEqual({
    bytes: 0,
    stamp: null,
    generation: '1'
  });
});
