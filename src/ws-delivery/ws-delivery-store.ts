import { createHash } from 'node:crypto';
import { getRedisClient } from '@/redis';

const WINDOW_MS = 5 * 60_000;

export interface DeliverySnapshot {
  attempted: number;
  sent: number;
  throttled: number;
  deferred: number;
  connections: number;
  healthyConnections: number;
  recentlyHealthyConnections: number;
  throttledConnections: number;
  pending: number;
  oldestFailureAt: number;
}

export interface DeliveryClaim {
  acquired: boolean;
  revision: number;
  failures: number;
  firstFailureAt: number;
}

// Every key shares a Redis Cluster slot. No payload, JWT or user identity is
// retained. Connection IDs exist only in the private retry state, never metrics.
export function deliveryScope(): string {
  const endpoint = process.env.API_GATEWAY_WS_ENDPOINT ?? 'local';
  return `ws-delivery:v1:{${createHash('sha256').update(endpoint).digest('hex').slice(0, 24)}}`;
}

export function connectionHash(connectionId: string): string {
  return createHash('sha256')
    .update(`${deliveryScope()}:${connectionId}`)
    .digest('hex');
}

const commonLua = `
local now = tonumber(ARGV[1])
local id = ARGV[2]
local ttl = 3600
local function metric(name)
  redis.call('HINCRBY', KEYS[3], name, 1)
  redis.call('EXPIRE', KEYS[3], ttl)
end
local function seen(key)
  redis.call('ZADD', key, now, id)
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - 300000)
  redis.call('EXPIRE', key, ttl)
end
local function pending(at)
  redis.call('HSET', KEYS[1], 'connectionId', ARGV[3])
  redis.call('HINCRBY', KEYS[1], 'revision', 1)
  redis.call('ZADD', KEYS[2], at, id)
  redis.call('ZADD', KEYS[8], 'NX', now, id)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[8], ttl)
end
`;

const claimLua = `${commonLua}
local due = tonumber(redis.call('HGET', KEYS[1], 'nextAttempt') or '0')
local lease = tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0')
local pause = tonumber(redis.call('GET', KEYS[7]) or '0')
local recovery = ARGV[5] == '1'
local priority = ARGV[6] == '1'
if recovery and not redis.call('ZSCORE', KEYS[2], id) then return {0,0,0,0} end
if not priority and (due > now or lease > now or (not recovery and pause > now)) then
  metric('deferred')
  pending(math.max(due, lease, pause))
  return {0,0,0,0}
end
redis.call('HSET', KEYS[1], 'connectionId', ARGV[3])
if recovery then
  redis.call('HSET', KEYS[1], 'leaseToken', ARGV[4], 'leaseUntil', now + 30000)
end
redis.call('EXPIRE', KEYS[1], ttl)
metric('attempted')
seen(KEYS[4])
return {1, tonumber(redis.call('HGET', KEYS[1], 'revision') or '0'),
  tonumber(redis.call('HGET', KEYS[1], 'failures') or '0'),
  tonumber(redis.call('HGET', KEYS[1], 'firstFailureAt') or '0')}
`;

const finishLua = `${commonLua}
local result = ARGV[5]
metric(result)
if result == 'sent' then seen(KEYS[5]) end
if result == 'throttled' then seen(KEYS[6]) end
local recovery = ARGV[6] == '1'
if recovery and redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[4] then return 0 end
if recovery then redis.call('HDEL', KEYS[1], 'leaseToken', 'leaseUntil') end
if result == 'gone' then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[8], id)
  return 0
end
if result == 'throttled' then
  local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
  local first = tonumber(redis.call('HGET', KEYS[1], 'firstFailureAt') or '0')
  if first == 0 then first = now end
  local delay = math.min(300000, 30000 * math.pow(2, math.min(failures - 1, 4)))
  local nextAt = now + math.floor(delay * (0.75 + tonumber(ARGV[8]) * 0.5))
  redis.call('HSET', KEYS[1], 'firstFailureAt', first, 'nextAttempt', nextAt)
  pending(nextAt)
  local failed = redis.call('ZCOUNT', KEYS[6], now - 60000, '+inf')
  local attempted = redis.call('ZCOUNT', KEYS[4], now - 60000, '+inf')
  if failed >= 5 and failed / math.max(1, attempted) >= 0.2 then
    redis.call('SET', KEYS[7], now + 5000, 'PX', 10000)
  end
  if failures == 1 then return 1 end
  return 0
end
if result == 'sent' and recovery then
  local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
  if revision == tonumber(ARGV[7]) then
    redis.call('HSET', KEYS[1], 'failures', 0, 'firstFailureAt', 0, 'nextAttempt', 0)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', KEYS[8], id)
  elseif redis.call('ZSCORE', KEYS[2], id) then
    local due = tonumber(redis.call('HGET', KEYS[1], 'nextAttempt') or '0')
    redis.call('ZADD', KEYS[2], math.max(now, due), id)
  end
end
if result == 'failed' and redis.call('ZSCORE', KEYS[2], id) then
  redis.call('HSET', KEYS[1], 'nextAttempt', now + 60000)
  redis.call('ZADD', KEYS[2], now + 60000, id)
end
return 0
`;

export class WebSocketDeliveryStore {
  async forget(connectionId: string): Promise<void> {
    await this.bounded(async () => {
      const base = deliveryScope();
      await getRedisClient()!
        .multi()
        .del(`${base}:connection:${connectionHash(connectionId)}`)
        .zRem(`${base}:pending`, connectionHash(connectionId))
        .zRem(`${base}:pendingSince`, connectionHash(connectionId))
        .exec();
    });
  }

  private keys(connectionId: string, now: number): string[] {
    const base = deliveryScope();
    return [
      `${base}:connection:${connectionHash(connectionId)}`,
      `${base}:pending`,
      `${base}:minute:${Math.floor(now / 60_000)}`,
      `${base}:attempted`,
      `${base}:sent`,
      `${base}:throttled`,
      `${base}:pause`,
      `${base}:pendingSince`
    ];
  }

  private async bounded<T>(action: () => Promise<T>): Promise<T> {
    const client = getRedisClient();
    if (!client?.isReady)
      throw new Error('WebSocket recovery store unavailable');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('WebSocket recovery store timeout')),
            250
          );
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async claim(
    connectionId: string,
    token: string,
    recovery: boolean,
    now: number,
    priority = false
  ): Promise<DeliveryClaim> {
    const result = (await this.bounded(() =>
      getRedisClient()!.eval(claimLua, {
        keys: this.keys(connectionId, now),
        arguments: [
          String(now),
          connectionHash(connectionId),
          connectionId,
          token,
          recovery ? '1' : '0',
          priority ? '1' : '0'
        ]
      })
    )) as number[];
    return {
      acquired: result[0] === 1,
      revision: result[1],
      failures: result[2],
      firstFailureAt: result[3]
    };
  }

  async finish(input: {
    connectionId: string;
    token: string;
    outcome: 'sent' | 'throttled' | 'gone' | 'failed';
    recovery: boolean;
    revision: number;
    now: number;
    jitter: number;
  }): Promise<boolean> {
    const result = await this.bounded(() =>
      getRedisClient()!.eval(finishLua, {
        keys: this.keys(input.connectionId, input.now),
        arguments: [
          String(input.now),
          connectionHash(input.connectionId),
          input.connectionId,
          input.token,
          input.outcome,
          input.recovery ? '1' : '0',
          String(input.revision),
          String(input.jitter)
        ]
      })
    );
    return Number(result) === 1;
  }

  async due(now: number, limit = 100): Promise<string[]> {
    return this.bounded(async () => {
      const client = getRedisClient()!;
      const base = deliveryScope();
      const ids = await client.zRangeByScore(`${base}:pending`, 0, now, {
        LIMIT: { offset: 0, count: limit }
      });
      const records = await Promise.all(
        ids.map(async (id) => {
          const value = await client.hGet(
            `${base}:connection:${id}`,
            'connectionId'
          );
          if (!value)
            await client
              .multi()
              .zRem(`${base}:pending`, id)
              .zRem(`${base}:pendingSince`, id)
              .exec();
          return value;
        })
      );
      return records.filter((id): id is string => typeof id === 'string');
    });
  }

  async snapshot(
    now: number,
    excludeConnectionId?: string
  ): Promise<DeliverySnapshot> {
    return this.bounded(async () => {
      const client = getRedisClient()!;
      const base = deliveryScope();
      const minute = Math.floor(now / 60_000);
      const [
        buckets,
        connections,
        healthyConnections,
        recentlyHealthyConnections,
        throttledConnections,
        pending,
        oldest,
        ownSuccess
      ] = await Promise.all([
        Promise.all(
          Array.from({ length: 5 }, (_, offset) =>
            client.hGetAll(`${base}:minute:${minute - offset}`)
          )
        ),
        client.zCount(`${base}:attempted`, now - WINDOW_MS, '+inf'),
        client.zCount(`${base}:sent`, now - WINDOW_MS, '+inf'),
        client.zCount(`${base}:sent`, now - 120_000, '+inf'),
        client.zCount(`${base}:throttled`, now - WINDOW_MS, '+inf'),
        client.zCard(`${base}:pending`),
        client.zRangeWithScores(`${base}:pendingSince`, 0, 0),
        excludeConnectionId
          ? client.zScore(`${base}:sent`, connectionHash(excludeConnectionId))
          : Promise.resolve(null)
      ]);
      const sum = (key: string) =>
        buckets.reduce((total, bucket) => total + Number(bucket[key] ?? 0), 0);
      return {
        attempted: sum('attempted'),
        sent: sum('sent'),
        throttled: sum('throttled'),
        deferred: sum('deferred'),
        connections,
        healthyConnections: Math.max(
          0,
          healthyConnections -
            Number(ownSuccess !== null && ownSuccess >= now - WINDOW_MS)
        ),
        recentlyHealthyConnections: Math.max(
          0,
          recentlyHealthyConnections -
            Number(ownSuccess !== null && ownSuccess >= now - 120_000)
        ),
        throttledConnections,
        pending,
        oldestFailureAt: oldest[0]?.score ?? 0
      };
    });
  }
}

export const webSocketDeliveryStore = new WebSocketDeliveryStore();
