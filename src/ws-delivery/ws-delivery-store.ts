import { createHash } from 'node:crypto';
import { getRedisClient } from '@/redis';
import {
  createCluster,
  defineScript,
  type RedisClientType,
  type RedisClusterOptions
} from 'redis';

const WINDOW_MS = 5 * 60_000;
// Keep connection capabilities beyond AWS's two-hour lifetime, including handshake margin.
const STATE_TTL_SECONDS = 2 * 60 * 60 + 5 * 60;

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
  canReconnect?: boolean;
}

// Every key shares a Redis Cluster slot. No payload, JWT or user identity is
// retained. Connection IDs exist only in the private retry state, never metrics.
let scopeCache: { endpoint: string; scope: string } | undefined;

export function deliveryScope(): string {
  const endpoint = process.env.API_GATEWAY_WS_ENDPOINT ?? 'local';
  if (scopeCache?.endpoint !== endpoint) {
    scopeCache = {
      endpoint,
      scope: `ws-delivery:v1:{${createHash('sha256').update(endpoint).digest('hex').slice(0, 24)}}`
    };
  }
  return scopeCache.scope;
}

export function connectionHash(connectionId: string): string {
  return createHash('sha256')
    .update(`${deliveryScope()}:${connectionId}`)
    .digest('hex');
}

// One operation's logic, written against K and A instead of KEYS and ARGV so
// the same text runs alone (K = KEYS, A = ARGV) and once per operation inside
// a batch. K: connection, pending, minute, attempted, sent, throttled, pause,
// pendingSince. A[1] is the operation's now, A[2] the connection hash.
const commonLua = `
local now = tonumber(A[1])
local id = A[2]
local ttl = ${STATE_TTL_SECONDS}
local function metric(name)
  redis.call('HINCRBY', K[3], name, 1)
  redis.call('EXPIRE', K[3], ttl)
end
local function seen(key)
  redis.call('ZADD', key, now, id)
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - 300000)
  redis.call('EXPIRE', key, ttl)
end
local function pending(at)
  redis.call('HSET', K[1], 'connectionId', A[3])
  redis.call('HINCRBY', K[1], 'revision', 1)
  redis.call('ZADD', K[2], at, id)
  redis.call('ZADD', K[8], 'NX', now, id)
  redis.call('EXPIRE', K[1], ttl)
  redis.call('EXPIRE', K[2], ttl)
  redis.call('EXPIRE', K[8], ttl)
end
`;

// A: now, id, connectionId, token, recovery, priority.
const claimBody = `${commonLua}
local due = tonumber(redis.call('HGET', K[1], 'nextAttempt') or '0')
local lease = tonumber(redis.call('HGET', K[1], 'leaseUntil') or '0')
local pause = tonumber(redis.call('GET', K[7]) or '0')
local recovery = A[5] == '1'
local priority = A[6] == '1'
if recovery and not redis.call('ZSCORE', K[2], id) then return {0,0,0,0} end
if not priority and (due > now or lease > now or (not recovery and pause > now)) then
  metric('deferred')
  pending(math.max(due, lease, pause))
  return {0,0,0,0}
end
redis.call('HSET', K[1], 'connectionId', A[3])
if recovery then
  redis.call('HSET', K[1], 'leaseToken', A[4], 'leaseUntil', now + 30000)
end
redis.call('EXPIRE', K[1], ttl)
metric('attempted')
seen(K[4])
return {1, tonumber(redis.call('HGET', K[1], 'revision') or '0'),
  tonumber(redis.call('HGET', K[1], 'failures') or '0'),
  tonumber(redis.call('HGET', K[1], 'firstFailureAt') or '0'),
  redis.call('HGET', K[1], 'canReconnect') == '1' and 1 or 0}
`;

// A: now, id, connectionId, token, outcome, recovery, revision, jitter, coalesce.
const finishBody = `${commonLua}
local result = A[5]
metric(result)
if result == 'sent' then seen(K[5]) end
if result == 'throttled' then seen(K[6]) end
local recovery = A[6] == '1'
if recovery and redis.call('HGET', K[1], 'leaseToken') ~= A[4] then return 0 end
if recovery then redis.call('HDEL', K[1], 'leaseToken', 'leaseUntil') end
if result == 'gone' then
  redis.call('DEL', K[1])
  redis.call('ZREM', K[2], id)
  redis.call('ZREM', K[8], id)
  return 0
end
if result == 'sent' then
  redis.call('HSET', K[1], 'failures', 0, 'firstFailureAt', 0)
  redis.call('EXPIRE', K[1], ttl)
end
if result == 'throttled' then
  local failures = redis.call('HINCRBY', K[1], 'failures', 1)
  local first = tonumber(redis.call('HGET', K[1], 'firstFailureAt') or '0')
  if first == 0 then first = now end
  local delay = math.min(300000, 30000 * math.pow(2, math.min(failures - 1, 4)))
  local nextAt = now + math.floor(delay * (0.75 + tonumber(A[8]) * 0.5))
  redis.call('HSET', K[1], 'firstFailureAt', first, 'nextAttempt', nextAt)
  if A[9] ~= '0' then
    pending(nextAt)
  elseif redis.call('ZSCORE', K[2], id) then
    redis.call('ZADD', K[2], nextAt, id)
  end
  local failed = redis.call('ZCOUNT', K[6], now - 60000, '+inf')
  local attempted = redis.call('ZCOUNT', K[4], now - 60000, '+inf')
  if failed >= 5 and failed / math.max(1, attempted) >= 0.2 then
    redis.call('SET', K[7], now + 5000, 'PX', 10000)
  end
  if failures == 1 then return 1 end
  return 0
end
if result == 'sent' and recovery then
  local revision = tonumber(redis.call('HGET', K[1], 'revision') or '0')
  if revision == tonumber(A[7]) then
    redis.call('HSET', K[1], 'nextAttempt', 0)
    redis.call('ZREM', K[2], id)
    redis.call('ZREM', K[8], id)
  elseif redis.call('ZSCORE', K[2], id) then
    local due = tonumber(redis.call('HGET', K[1], 'nextAttempt') or '0')
    redis.call('ZADD', K[2], math.max(now, due), id)
  end
end
if result == 'failed' and redis.call('ZSCORE', K[2], id) then
  redis.call('HSET', K[1], 'nextAttempt', now + 60000)
  redis.call('ZADD', K[2], now + 60000, id)
  redis.call('EXPIRE', K[2], ttl)
  redis.call('EXPIRE', K[8], ttl)
end
return 0
`;

const operationsLua = `
local function claim(K, A)
${claimBody}
end
local function finish(K, A)
${finishBody}
end
`;

const claimLua = `${operationsLua}
return claim(KEYS, ARGV)
`;

const finishLua = `${operationsLua}
return finish(KEYS, ARGV)
`;

const CLAIM_ARGUMENTS = 6;
const FINISH_ARGUMENTS = 9;
const SHARED_KEYS = 6;

/**
 * Runs queued claims and finishes in order, as if each ran alone: the same
 * operation bodies, back to back in one atomic call. KEYS: pending,
 * attempted, sent, throttled, pause, pendingSince, then each operation's
 * connection and minute keys. ARGV: per operation, 'c' or 'f' and its
 * arguments. One operation's error is caught and returned in its place, so
 * it fails alone, as it would have on its own.
 */
const batchLua = `${operationsLua}
local results = {}
local k = ${SHARED_KEYS} + 1
local a = 1
while a <= #ARGV do
  local kind = ARGV[a]
  local width = kind == 'c' and ${CLAIM_ARGUMENTS} or ${FINISH_ARGUMENTS}
  local K = {KEYS[k], KEYS[1], KEYS[k + 1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]}
  local A = {}
  for j = 1, width do A[j] = ARGV[a + j] end
  local ok, result = pcall(kind == 'c' and claim or finish, K, A)
  if ok then
    results[#results + 1] = result
  elseif type(result) == 'table' and result.err then
    results[#results + 1] = 'ERR ' .. result.err
  else
    results[#results + 1] = 'ERR ' .. tostring(result)
  end
  k = k + 2
  a = a + 1 + width
end
return results
`;

type ScriptOptions = { keys: string[]; arguments: string[] };

function defineDeliveryScript(script: string) {
  return defineScript({
    SCRIPT: script,
    // The first key follows the key count in the arguments below.
    FIRST_KEY_INDEX: 1,
    transformArguments: ({ keys, arguments: args }: ScriptOptions) => [
      String(keys.length),
      ...keys,
      ...args
    ]
  });
}

const deliveryScripts = {
  claimDelivery: defineDeliveryScript(claimLua),
  finishDelivery: defineDeliveryScript(finishLua),
  batchDelivery: defineDeliveryScript(batchLua)
};

type DeliveryScript = keyof typeof deliveryScripts;

export function createWebSocketDeliveryCluster(options: RedisClusterOptions) {
  return createCluster({ ...options, scripts: deliveryScripts });
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

type DeliveryRedis =
  | RedisClientType
  | ReturnType<typeof createWebSocketDeliveryCluster>;

function getReadySharedRedis(): DeliveryRedis | null {
  const client = getRedisClient();
  return client?.isReady ? client : null;
}

/**
 * `WS_DELIVERY_BATCHED_BOOKKEEPING=off` sends each claim and finish as its
 * own call again. Read on use; anything else, or unset, batches.
 */
function batchedBookkeeping(): boolean {
  const value =
    process.env.WS_DELIVERY_BATCHED_BOOKKEEPING?.trim().toLowerCase();
  return value !== 'off' && value !== 'false' && value !== '0';
}

/** Bounds one batch call's Lua run time and reply size. */
const MAX_BATCH_OPERATIONS = 64;

interface QueuedOperation {
  readonly kind: 'c' | 'f';
  readonly connectionKey: string;
  readonly minuteKey: string;
  readonly args: string[];
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Collects the claims and finishes requested in one turn of the event loop
 * and runs them, in request order, in one Redis call. Operations requested
 * concurrently (a fan-out's in-flight sends) then share one round trip and
 * one command's overhead instead of paying it each. Order is preserved:
 * calls go out in queue order on one connection, so Redis runs every
 * operation in the order it was requested, as it did one call at a time.
 */
class BookkeepingBatcher {
  private queue: QueuedOperation[] = [];
  private queueScope = '';
  private scheduled = false;

  constructor(
    private readonly execute: (options: ScriptOptions) => Promise<unknown>
  ) {}

  enqueue(scope: string, operation: QueuedOperation): void {
    if (this.queue.length && scope !== this.queueScope) this.flush();
    this.queueScope = scope;
    this.queue.push(operation);
    if (this.queue.length >= MAX_BATCH_OPERATIONS) {
      this.flush();
    } else if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  private flush(): void {
    const operations = this.queue;
    if (!operations.length) return;
    this.queue = [];
    void runBatch(this.queueScope, operations, this.execute);
  }
}

async function runBatch(
  scope: string,
  operations: QueuedOperation[],
  execute: (options: ScriptOptions) => Promise<unknown>
): Promise<void> {
  const keys = [
    `${scope}:pending`,
    `${scope}:attempted`,
    `${scope}:sent`,
    `${scope}:throttled`,
    `${scope}:pause`,
    `${scope}:pendingSince`
  ];
  const args: string[] = [];
  for (const operation of operations) {
    keys.push(operation.connectionKey, operation.minuteKey);
    args.push(operation.kind, ...operation.args);
  }
  let results: unknown;
  try {
    results = await execute({ keys, arguments: args });
  } catch (error) {
    for (const operation of operations) operation.reject(error);
    return;
  }
  const list = Array.isArray(results) ? results : [];
  operations.forEach((operation, index) => {
    const result: unknown = list[index];
    if (result === undefined) {
      operation.reject(
        new Error('WebSocket recovery store returned no result')
      );
    } else if (typeof result === 'string' && result.startsWith('ERR')) {
      operation.reject(new Error(result));
    } else {
      operation.resolve(result);
    }
  });
}

export class WebSocketDeliveryStore {
  private readonly scriptHashes = new Map<string, Promise<string>>();
  private readonly batcher = new BookkeepingBatcher((options) =>
    this.runScript('batchDelivery', options)
  );

  constructor(
    private readonly batched: () => boolean = batchedBookkeeping,
    private readonly getClient: () => DeliveryRedis | null = getReadySharedRedis
  ) {}

  /** Fails fast when Redis is down and bounds each call to 250 ms. */
  private async bounded<T>(
    action: (client: DeliveryRedis) => Promise<T>
  ): Promise<T> {
    const client = this.getClient();
    if (!client) throw new Error('WebSocket recovery store unavailable');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(client),
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

  private scriptHash(client: RedisClientType, script: string): Promise<string> {
    let hash = this.scriptHashes.get(script);
    if (!hash) {
      hash = client.scriptLoad(script);
      this.scriptHashes.set(script, hash);
      hash.catch(() => this.scriptHashes.delete(script));
    }
    return hash;
  }

  private runScript(
    script: DeliveryScript,
    options: ScriptOptions
  ): Promise<unknown> {
    return this.bounded(async (client) => {
      // The cluster client routes the script by key and handles NOSCRIPT
      // on the selected primary. SCRIPT LOAD has no key for routing.
      if (!('scriptLoad' in client)) {
        return client[script](options);
      }

      const source = deliveryScripts[script].SCRIPT;
      try {
        return await client.evalSha(
          await this.scriptHash(client, source),
          options
        );
      } catch (error) {
        if (!isNoScript(error)) throw error;
        this.scriptHashes.delete(source);
        return client.eval(source, options);
      }
    });
  }

  async enableReconnect(connectionId: string): Promise<void> {
    await this.bounded(async (client) => {
      const key = `${deliveryScope()}:connection:${connectionHash(connectionId)}`;
      await client
        .multi()
        .hSet(key, 'canReconnect', '1')
        .expire(key, STATE_TTL_SECONDS)
        .exec();
    });
  }

  async forget(connectionId: string): Promise<void> {
    await this.bounded(async (client) => {
      const base = deliveryScope();
      await client
        .multi()
        .del(`${base}:connection:${connectionHash(connectionId)}`)
        .zRem(`${base}:pending`, connectionHash(connectionId))
        .zRem(`${base}:pendingSince`, connectionHash(connectionId))
        .exec();
    });
  }

  /**
   * Runs one claim ('c') or finish ('f'): queued into the next batch, or as
   * its own call when batching is off. Same keys and arguments either way.
   */
  private operation(
    kind: 'c' | 'f',
    connectionId: string,
    now: number,
    rest: string[]
  ): Promise<unknown> {
    const scope = deliveryScope();
    const hash = connectionHash(connectionId);
    const connectionKey = `${scope}:connection:${hash}`;
    const minuteKey = `${scope}:minute:${Math.floor(now / 60_000)}`;
    const args = [String(now), hash, connectionId, ...rest];
    if (!this.batched()) {
      return this.runScript(kind === 'c' ? 'claimDelivery' : 'finishDelivery', {
        keys: [
          connectionKey,
          `${scope}:pending`,
          minuteKey,
          `${scope}:attempted`,
          `${scope}:sent`,
          `${scope}:throttled`,
          `${scope}:pause`,
          `${scope}:pendingSince`
        ],
        arguments: args
      });
    }
    if (!this.getClient()) {
      return Promise.reject(new Error('WebSocket recovery store unavailable'));
    }
    return new Promise((resolve, reject) => {
      this.batcher.enqueue(scope, {
        kind,
        connectionKey,
        minuteKey,
        args,
        resolve,
        reject
      });
    });
  }

  async claim(
    connectionId: string,
    token: string,
    recovery: boolean,
    now: number,
    priority = false
  ): Promise<DeliveryClaim> {
    const result = (await this.operation('c', connectionId, now, [
      token,
      recovery ? '1' : '0',
      priority ? '1' : '0'
    ])) as number[];
    return {
      acquired: result[0] === 1,
      revision: result[1],
      failures: result[2],
      firstFailureAt: result[3],
      canReconnect: result[4] === 1
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
    coalesce?: boolean;
  }): Promise<boolean> {
    const result = await this.operation('f', input.connectionId, input.now, [
      input.token,
      input.outcome,
      input.recovery ? '1' : '0',
      String(input.revision),
      String(input.jitter),
      input.coalesce === false ? '0' : '1'
    ]);
    return Number(result) === 1;
  }

  async due(now: number, limit = 100): Promise<string[]> {
    return this.bounded(async (client) => {
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
    return this.bounded(async (client) => {
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
