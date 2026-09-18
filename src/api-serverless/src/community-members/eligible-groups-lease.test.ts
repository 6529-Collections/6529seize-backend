import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient, RedisClientType } from 'redis';
import { getRedisClient, WAVE_GROUPS_VERSION_CACHE_KEY } from '@/redis';
import { UserGroupsService } from './user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { AbusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import * as mcache from 'memory-cache';
import {
  acquireEligibleGroupsLease,
  eligibleGroupsLeaseKeys,
  invalidateEligibleGroupsResult,
  publishEligibleGroupsResult,
  releaseEligibleGroupsLease,
  renewEligibleGroupsLease
} from './eligible-groups-lease';

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn()
}));

let container: StartedTestContainer;
let client: RedisClientType;
const profile = 'profile-for-lease-test';

beforeAll(async () => {
  container = await new GenericContainer('redis:latest')
    .withExposedPorts(6379)
    .start();
  client = createClient({
    socket: { host: container.getHost(), port: container.getMappedPort(6379) }
  });
  await client.connect();
  (getRedisClient as jest.Mock).mockReturnValue(client);
}, 30_000);

afterAll(async () => {
  await client?.quit();
  await container?.stop();
});

beforeEach(async () => {
  mcache.clear();
  (getRedisClient as jest.Mock).mockReturnValue(client);
  const keys = eligibleGroupsLeaseKeys(profile);
  await client.del([keys.result, keys.lease, keys.invalidation]);
  await client.set(WAVE_GROUPS_VERSION_CACHE_KEY, '7');
});

function serviceForTest() {
  const db = {
    getLatestProfileGroupChangeMillis: jest.fn().mockResolvedValue(null)
  };
  const service = new UserGroupsService(
    db as unknown as UserGroupsDb,
    {} as AbusivenessCheckService,
    {} as MetricsRecorder
  );
  return { service, db };
}

type CacheMethod = {
  getGroupsUserIsEligibleForWithCache(profileId: string): Promise<string[]>;
};
type ComputeMethod = {
  computeGroupsUserIsEligibleFor(profileId: string): Promise<string[]>;
};

function readCache(service: UserGroupsService, profileId = profile) {
  // Bypass the module-level promise map to model independent Lambda contexts.
  return (
    service as unknown as CacheMethod
  ).getGroupsUserIsEligibleForWithCache(profileId);
}

it.each(['ordinary-profile', '123e4567-e89b-12d3-a456-426614174000'])(
  'places all keys for %s in the legacy result slot',
  (id) => {
    const keys = eligibleGroupsLeaseKeys(id);
    const slotInput = (key: string) => {
      const open = key.indexOf('{');
      const close = key.indexOf('}', open + 1);
      return open >= 0 && close > open + 1 ? key.slice(open + 1, close) : key;
    };
    expect(new Set(Object.values(keys).map(slotInput)).size).toBe(1);
  }
);

it('rejects profile IDs that could change the legacy key hash slot', () => {
  expect(() => eligibleGroupsLeaseKeys('profile-{other}')).toThrow(
    'Unsupported profile ID'
  );
});

it('permits one owner and atomically publishes a result for followers', async () => {
  const [first, second] = await Promise.all([
    acquireEligibleGroupsLease(profile),
    acquireEligibleGroupsLease(profile)
  ]);
  const owner = first ?? second;
  expect(owner).not.toBeNull();
  expect([first, second].filter(Boolean)).toHaveLength(1);
  expect(await renewEligibleGroupsLease(profile, owner!.token)).toBe(true);
  expect(
    await publishEligibleGroupsResult(
      profile,
      owner!.token,
      owner!.invalidation,
      'result-a',
      60
    )
  ).toBe(true);
  expect(await client.get(eligibleGroupsLeaseKeys(profile).result)).toBe(
    'result-a'
  );
  expect(await client.get(eligibleGroupsLeaseKeys(profile).lease)).toBeNull();
});

it('rejects an expired owner after replacement and preserves the new owner', async () => {
  const first = (await acquireEligibleGroupsLease(profile))!;
  const keys = eligibleGroupsLeaseKeys(profile);
  await client.pExpire(keys.lease, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replacement = (await acquireEligibleGroupsLease(profile))!;
  expect(replacement.token).not.toBe(first.token);
  expect(await renewEligibleGroupsLease(profile, first.token)).toBe(false);
  expect(
    await publishEligibleGroupsResult(
      profile,
      first.token,
      first.invalidation,
      'old',
      60
    )
  ).toBe(false);
  await releaseEligibleGroupsLease(profile, first.token);
  expect(await client.get(keys.lease)).toBe(replacement.token);
  expect(
    await publishEligibleGroupsResult(
      profile,
      replacement.token,
      replacement.invalidation,
      'new',
      60
    )
  ).toBe(true);
  expect(await client.get(keys.result)).toBe('new');
});

it('blocks publication after explicit invalidation during computation', async () => {
  const owner = (await acquireEligibleGroupsLease(profile))!;
  await invalidateEligibleGroupsResult(profile, 60);
  expect(
    await publishEligibleGroupsResult(
      profile,
      owner.token,
      owner.invalidation,
      'stale',
      60
    )
  ).toBe(false);
  expect(await client.get(eligibleGroupsLeaseKeys(profile).result)).toBeNull();
});

it('retains the invalidation marker beyond a configured cache TTL', async () => {
  await invalidateEligibleGroupsResult(profile, 120);
  expect(
    await client.pTTL(eligibleGroupsLeaseKeys(profile).invalidation)
  ).toBeGreaterThan(120_000);
});

it('rejects an old-instance result published after new-code invalidation', async () => {
  await invalidateEligibleGroupsResult(profile, 60);
  await client.set(
    eligibleGroupsLeaseKeys(profile).result,
    JSON.stringify({
      eligibleGroupIds: ['old-permission'],
      computedAtMillis: Date.now(),
      waveGroupsVersion: 7
    }),
    { EX: 60 }
  );
  const service = serviceForTest().service;
  const compute = jest
    .spyOn(
      service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValue(['current-permission']);
  await expect(readCache(service)).resolves.toEqual(['current-permission']);
  expect(compute).toHaveBeenCalledTimes(1);
});

it('shares one computation between independent service instances', async () => {
  const first = serviceForTest().service;
  const second = serviceForTest().service;
  let finish: (groups: string[]) => void = () => undefined;
  const work = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const firstCompute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(work);
  const secondCompute = jest
    .spyOn(second as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockResolvedValue(['unexpected']);
  const owner = readCache(first);
  while (firstCompute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const follower = readCache(second);
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish(['group-a']);
  expect(await owner).toEqual(['group-a']);
  expect(await follower).toEqual(['group-a']);
  expect(firstCompute).toHaveBeenCalledTimes(1);
  expect(secondCompute).not.toHaveBeenCalled();
});

it('rechecks a result published just before lease acquisition', async () => {
  const keys = eligibleGroupsLeaseKeys(profile);
  const cached = JSON.stringify({
    eligibleGroupIds: ['peer-result'],
    computedAtMillis: Date.now(),
    waveGroupsVersion: 7
  });
  const get = client.get.bind(client);
  const set = client.set.bind(client);
  let firstRead = true;
  (getRedisClient as jest.Mock).mockReturnValue({
    get: async (key: string) => {
      if (key === keys.result && firstRead) {
        firstRead = false;
        await set(key, cached);
        return null;
      }
      return get(key);
    },
    set,
    eval: client.eval.bind(client)
  });
  const service = serviceForTest().service;
  const compute = jest
    .spyOn(
      service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValue(['unexpected']);
  await expect(readCache(service)).resolves.toEqual(['peer-result']);
  expect(compute).not.toHaveBeenCalled();
});

it('releases a failed owner so one follower takes over', async () => {
  const first = serviceForTest().service;
  const second = serviceForTest().service;
  let fail: (error: Error) => void = () => undefined;
  const work = new Promise<string[]>((_, reject) => {
    fail = reject;
  });
  const firstCompute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(work);
  const secondCompute = jest
    .spyOn(second as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockResolvedValue(['group-b']);
  const owner = readCache(first);
  while (firstCompute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const follower = readCache(second);
  fail(new Error('owner failed'));
  await expect(owner).rejects.toThrow('owner failed');
  await expect(follower).resolves.toEqual(['group-b']);
  expect(secondCompute).toHaveBeenCalledTimes(1);
});

it('rejects a computation invalidated in flight', async () => {
  const first = serviceForTest().service;
  let finish: (groups: string[]) => void = () => undefined;
  const work = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const compute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(work);
  const owner = readCache(first);
  while (compute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await invalidateEligibleGroupsResult(profile, 60);
  finish(['stale']);
  await expect(owner).rejects.toMatchObject({ status: 503 });
  expect(await client.get(eligibleGroupsLeaseKeys(profile).result)).toBeNull();
});

it('rejects a warm memory entry after another instance invalidates the profile', async () => {
  const service = serviceForTest().service;
  const compute = jest
    .spyOn(
      service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValueOnce(['old-permission'])
    .mockResolvedValueOnce(['new-permission']);
  await expect(readCache(service)).resolves.toEqual(['old-permission']);
  await invalidateEligibleGroupsResult(profile, 60);
  await expect(readCache(service)).resolves.toEqual(['new-permission']);
  expect(compute).toHaveBeenCalledTimes(2);
});

it('allows different profiles to compute independently', async () => {
  const otherProfile = 'another-profile-for-lease-test';
  const otherKeys = eligibleGroupsLeaseKeys(otherProfile);
  await client.del([otherKeys.result, otherKeys.lease, otherKeys.invalidation]);
  const first = serviceForTest().service;
  const second = serviceForTest().service;
  let finish: (groups: string[]) => void = () => undefined;
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const firstCompute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(pending);
  jest
    .spyOn(second as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockResolvedValue(['other-group']);
  const firstRead = readCache(first);
  while (firstCompute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await expect(readCache(second, otherProfile)).resolves.toEqual([
    'other-group'
  ]);
  finish(['first-group']);
  await expect(firstRead).resolves.toEqual(['first-group']);
  await client.del([otherKeys.result, otherKeys.lease, otherKeys.invalidation]);
});

it('fails an owner whose global input version changes during computation', async () => {
  const first = serviceForTest().service;
  let finish: (groups: string[]) => void = () => undefined;
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const compute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(pending);
  const read = readCache(first);
  while (compute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await client.set(WAVE_GROUPS_VERSION_CACHE_KEY, '8');
  finish(['old-permission']);
  await expect(read).rejects.toMatchObject({ status: 503 });
  expect(await client.get(eligibleGroupsLeaseKeys(profile).result)).toBeNull();
});

it('does not reuse an obsolete result after a version changes while waiting', async () => {
  const first = serviceForTest().service;
  const second = serviceForTest().service;
  let finish: (groups: string[]) => void = () => undefined;
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const firstCompute = jest
    .spyOn(first as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockReturnValue(pending);
  const secondCompute = jest
    .spyOn(second as unknown as ComputeMethod, 'computeGroupsUserIsEligibleFor')
    .mockResolvedValue(['new-permission']);
  const owner = readCache(first);
  while (firstCompute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const follower = readCache(second);
  await client.set(WAVE_GROUPS_VERSION_CACHE_KEY, '8');
  finish(['old-permission']);
  await expect(owner).rejects.toMatchObject({ status: 503 });
  await expect(follower).resolves.toEqual(['new-permission']);
  expect(secondCompute).toHaveBeenCalledTimes(1);
});

it('rechecks profile changes while waiting and takes over after invalidation', async () => {
  let latestChange: number | null = null;
  const firstContext = serviceForTest();
  const secondContext = serviceForTest();
  firstContext.db.getLatestProfileGroupChangeMillis.mockImplementation(
    async () => latestChange
  );
  secondContext.db.getLatestProfileGroupChangeMillis.mockImplementation(
    async () => latestChange
  );
  let finish: (groups: string[]) => void = () => undefined;
  const pending = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const firstCompute = jest
    .spyOn(
      firstContext.service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockReturnValue(pending);
  const secondCompute = jest
    .spyOn(
      secondContext.service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValue(['current-permission']);
  const owner = readCache(firstContext.service);
  while (firstCompute.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const follower = readCache(secondContext.service);
  latestChange = Date.now() - 1_000;
  await invalidateEligibleGroupsResult(profile, 60);
  finish(['obsolete-permission']);
  await expect(owner).rejects.toMatchObject({ status: 503 });
  await expect(follower).resolves.toEqual(['current-permission']);
  expect(secondCompute).toHaveBeenCalledTimes(1);
});

it('returns a bounded retryable error while an owner never publishes', async () => {
  const lease = (await acquireEligibleGroupsLease(profile))!;
  const renew = setInterval(() => {
    void renewEligibleGroupsLease(profile, lease.token);
  }, 2_000);
  const service = serviceForTest().service;
  const compute = jest
    .spyOn(
      service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValue(['unexpected']);
  try {
    await expect(readCache(service)).rejects.toMatchObject({ status: 503 });
    expect(compute).not.toHaveBeenCalled();
  } finally {
    clearInterval(renew);
    await releaseEligibleGroupsLease(profile, lease.token);
  }
}, 20_000);

it('returns a retryable error without computing when Redis fails', async () => {
  const service = serviceForTest().service;
  const compute = jest
    .spyOn(
      service as unknown as ComputeMethod,
      'computeGroupsUserIsEligibleFor'
    )
    .mockResolvedValue(['unexpected']);
  (getRedisClient as jest.Mock).mockReturnValue({
    get: jest.fn().mockRejectedValue(new Error('redis unavailable'))
  });
  await expect(readCache(service)).rejects.toMatchObject({ status: 503 });
  expect(compute).not.toHaveBeenCalled();
});
