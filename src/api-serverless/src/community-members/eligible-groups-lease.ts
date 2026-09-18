import { randomUUID } from 'node:crypto';
import { getRedisClient } from '@/redis';

const LEASE_MS = 8_000;
const MIN_INVALIDATION_MARKER_MS = 60_000;
const MAX_REQUEST_MS = 12_000;

// The legacy result key has no hash tag for normal profile IDs. Using its
// complete bytes as the tag puts all three keys in one Redis Cluster slot.
export function eligibleGroupsLeaseKeys(profileId: string) {
  if (/[{}]/.test(profileId)) {
    throw new Error('Unsupported profile ID for eligibility lease');
  }
  const result = `cache_6529_eligible_groups:${profileId}`;
  const tag = `{${result}}`;
  return {
    result,
    lease: `cache_6529_eligible_groups_lease:${tag}`,
    invalidation: `cache_6529_eligible_groups_invalidation:${tag}`
  };
}

function clientOrThrow() {
  const client = getRedisClient();
  if (!client) throw new Error('Eligibility coordination Redis unavailable');
  return client;
}

export async function acquireEligibleGroupsLease(profileId: string) {
  const client = clientOrThrow();
  const keys = eligibleGroupsLeaseKeys(profileId);
  const token = randomUUID();
  const acquired = await client.set(keys.lease, token, {
    NX: true,
    PX: LEASE_MS
  });
  if (acquired !== 'OK') return null;
  try {
    const invalidation = (await client.get(keys.invalidation)) ?? '';
    return { token, invalidation };
  } catch (error) {
    await releaseEligibleGroupsLease(profileId, token).catch(() => undefined);
    throw error;
  }
}

export async function renewEligibleGroupsLease(
  profileId: string,
  token: string
) {
  const client = clientOrThrow();
  const { lease } = eligibleGroupsLeaseKeys(profileId);
  const result = await client.eval(
    `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     return redis.call('PEXPIRE', KEYS[1], ARGV[2])`,
    { keys: [lease], arguments: [token, String(LEASE_MS)] }
  );
  return Number(result) === 1;
}

export async function publishEligibleGroupsResult(
  profileId: string,
  token: string,
  invalidation: string,
  payload: string,
  ttlSec: number
) {
  const client = clientOrThrow();
  const {
    result,
    lease,
    invalidation: marker
  } = eligibleGroupsLeaseKeys(profileId);
  const published = await client.eval(
    `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
     if (redis.call('GET', KEYS[3]) or '') ~= ARGV[2] then return 0 end
     redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
     redis.call('DEL', KEYS[1])
     return 1`,
    {
      keys: [lease, result, marker],
      arguments: [token, invalidation, payload, String(ttlSec)]
    }
  );
  return Number(published) === 1;
}

export async function releaseEligibleGroupsLease(
  profileId: string,
  token: string
) {
  const client = clientOrThrow();
  const { lease } = eligibleGroupsLeaseKeys(profileId);
  await client.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
       return redis.call('DEL', KEYS[1])
     end
     return 0`,
    { keys: [lease], arguments: [token] }
  );
}

export async function invalidateEligibleGroupsResult(
  profileId: string,
  cacheTtlSec: number
) {
  const client = clientOrThrow();
  const { result, invalidation } = eligibleGroupsLeaseKeys(profileId);
  // Keep the marker longer than every result or warm memory entry created
  // under this TTL, including one that was being computed at invalidation.
  const markerMs = Math.max(
    MIN_INVALIDATION_MARKER_MS,
    cacheTtlSec * 1_000 + MAX_REQUEST_MS
  );
  await client.eval(
    `redis.call('INCR', KEYS[2])
     redis.call('PEXPIRE', KEYS[2], ARGV[1])
     return redis.call('DEL', KEYS[1])`,
    {
      keys: [result, invalidation],
      arguments: [String(markerMs)]
    }
  );
}

export async function readEligibleGroupsInvalidation(profileId: string) {
  const client = clientOrThrow();
  const { invalidation } = eligibleGroupsLeaseKeys(profileId);
  return (await client.get(invalidation)) ?? '';
}
