import { createHash, randomUUID } from 'node:crypto';
import { getRedisClient } from '@/redis';
import { CustomApiCompliantException } from '@/exceptions';

export const MARKET_BATCH_PREFLIGHT_TIMEOUT_MS = 12_000;
const LEASE_MS = MARKET_BATCH_PREFLIGHT_TIMEOUT_MS + 3_000;
// All keys have the same actor hash tag, including on clustered Redis.
const ACQUIRE = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local count = tonumber(redis.call('GET', KEYS[3]) or '0')
if count >= 12 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', 2000)
redis.call('INCR', KEYS[3])
if count == 0 then redis.call('PEXPIRE', KEYS[3], 60000) end
return 1`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

function unavailable() {
  return new CustomApiCompliantException(
    503,
    'The batch checks could not finish. Try again.',
    'MARKET_UNAVAILABLE'
  );
}

export async function withBatchPreflightLimit<T>(
  actor: string,
  operationId: string,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const client = getRedisClient();
  if (!client?.isReady) throw unavailable();
  const tag = createHash('sha256').update(actor).digest('hex');
  const prefix = `market:batch-preflight:{${tag}}`;
  const keys = [
    `${prefix}:lease`,
    `${prefix}:operation:${operationId}`,
    `${prefix}:count`
  ];
  const token = randomUUID();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(unavailable());
    }, MARKET_BATCH_PREFLIGHT_TIMEOUT_MS);
  });
  const run = async () => {
    try {
      let acquired: unknown;
      try {
        acquired = await client.eval(ACQUIRE, {
          keys,
          arguments: [token, String(LEASE_MS)]
        });
      } catch {
        throw unavailable();
      }
      controller.signal.throwIfAborted();
      if (acquired !== 1)
        throw new CustomApiCompliantException(
          429,
          'A batch check is already running or was requested too recently. Try again shortly.',
          'RATE_LIMITED'
        );
      return await work(controller.signal);
    } finally {
      // A timed-out request must never release another request's lease.
      await client
        .eval(RELEASE, { keys: [keys[0]], arguments: [token] })
        .catch(() => undefined);
    }
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}
