import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient } from 'redis';
import { forEachConcurrent } from '@/for-each-concurrent';
import {
  connectionHash,
  deliveryScope,
  WebSocketDeliveryStore
} from './ws-delivery-store';
import {
  DeliveryBatch,
  DeliveryMetricsBatch,
  WebSocketDelivery,
  WebSocketDeliveryResult
} from './ws-delivery';

let mockClient: ReturnType<typeof createClient>;
jest.mock('@/redis', () => ({ getRedisClient: () => mockClient }));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() })
  }
}));
// Fixed jitter so a throttle schedules the same retry time in both runs.
jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: () => 500_000
}));

/**
 * Batched bookkeeping must behave exactly like one call per claim and
 * finish. Each test runs the same work through both stores against real
 * Redis and compares every result and the whole Redis state afterwards.
 */
describe('batched delivery bookkeeping in real Redis', () => {
  let container: StartedTestContainer;
  const originalEndpoint = process.env.API_GATEWAY_WS_ENDPOINT;
  const perSend = new WebSocketDeliveryStore(() => false);
  const batched = new WebSocketDeliveryStore(() => true);

  beforeAll(async () => {
    container = await new GenericContainer('redis:7.4.5-alpine')
      .withExposedPorts(6379)
      .start();
    mockClient = createClient({
      url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`
    });
    await mockClient.connect();
  }, 60_000);
  afterAll(async () => {
    await mockClient?.quit();
    await container?.stop();
    if (originalEndpoint === undefined)
      delete process.env.API_GATEWAY_WS_ENDPOINT;
    else process.env.API_GATEWAY_WS_ENDPOINT = originalEndpoint;
  });
  beforeEach(async () => {
    process.env.API_GATEWAY_WS_ENDPOINT =
      'https://synthetic-api.invalid/production';
    await mockClient.flushDb();
    // Load both stores' scripts so a first-use SCRIPT LOAD cannot reorder
    // calls inside a test.
    await perSend.claim('warm-up', 'warm', false, 0);
    await perSend.finish({
      connectionId: 'warm-up',
      token: 'warm',
      outcome: 'sent',
      recovery: false,
      revision: 0,
      now: 0,
      jitter: 0
    });
    await batched.claim('warm-up', 'warm', false, 0);
    await mockClient.flushDb();
  });

  /** Every key, its contents and whether it expires, in a stable order. */
  async function redisState(): Promise<Record<string, unknown>> {
    const state: Record<string, unknown> = {};
    const keys = (await mockClient.keys('*')).sort((a, b) =>
      a.localeCompare(b)
    );
    for (const key of keys) {
      const type = await mockClient.type(key);
      const expires = (await mockClient.pTTL(key)) > 0;
      if (type === 'hash') {
        state[key] = { expires, value: await mockClient.hGetAll(key) };
      } else if (type === 'zset') {
        state[key] = {
          expires,
          value: await mockClient.zRangeWithScores(key, 0, -1)
        };
      } else {
        state[key] = { expires, value: await mockClient.get(key) };
      }
    }
    return state;
  }

  /** Makes one connection's state unreadable so its operations error. */
  async function breakConnection(connectionId: string): Promise<void> {
    await mockClient.set(
      `${deliveryScope()}:connection:${connectionHash(connectionId)}`,
      'not-a-hash'
    );
  }

  type Operation =
    | {
        kind: 'claim';
        connectionId: string;
        token: string;
        recovery: boolean;
        now: number;
        priority: boolean;
      }
    | {
        kind: 'finish';
        connectionId: string;
        token: string;
        outcome: 'sent' | 'throttled' | 'gone' | 'failed';
        recovery: boolean;
        revision: number;
        now: number;
        jitter: number;
        coalesce: boolean;
      };

  function randomOperations(seed: number, count: number): Operation[] {
    let state = seed;
    const random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(random() * values.length)];
    const connections = ['a', 'b', 'c', 'd', 'e', 'broken'];
    const tokens = ['t1', 't2', 't3'];
    const outcomes = ['sent', 'throttled', 'gone', 'failed'] as const;
    let now = 1_000_000;
    const operations: Operation[] = [];
    for (let i = 0; i < count; i++) {
      // Mostly close together, sometimes past a cooldown or a minute bucket.
      now += random() < 0.85 ? Math.floor(random() * 2_000) : 45_000;
      const connectionId = pick(connections);
      const token = pick(tokens);
      const recovery = random() < 0.3;
      if (random() < 0.5) {
        operations.push({
          kind: 'claim',
          connectionId,
          token,
          recovery,
          now,
          priority: random() < 0.1
        });
      } else {
        operations.push({
          kind: 'finish',
          connectionId,
          token,
          outcome: pick(outcomes),
          recovery,
          revision: Math.floor(random() * 4),
          now,
          jitter: Math.floor(random() * 1_000) / 1_000,
          coalesce: random() < 0.9
        });
      }
    }
    return operations;
  }

  function run(store: WebSocketDeliveryStore, operation: Operation) {
    return operation.kind === 'claim'
      ? store.claim(
          operation.connectionId,
          operation.token,
          operation.recovery,
          operation.now,
          operation.priority
        )
      : store.finish(operation);
  }

  function outcome(result: PromiseSettledResult<unknown>): unknown {
    return result.status === 'fulfilled' ? result.value : 'error';
  }

  it.each([1, 2, 3, 4, 5])(
    'matches one call per operation for a random sequence (seed %i)',
    async (seed) => {
      const operations = randomOperations(seed, 300);

      await breakConnection('broken');
      const expected: unknown[] = [];
      for (const operation of operations) {
        const [result] = await Promise.allSettled([run(perSend, operation)]);
        expected.push(outcome(result));
      }
      const expectedState = await redisState();

      await mockClient.flushDb();
      await breakConnection('broken');
      // Requested together, as a fan-out does: they share calls.
      const actual = (
        await Promise.allSettled(
          operations.map((operation) => run(batched, operation))
        )
      ).map(outcome);

      expect(actual).toEqual(expected);
      expect(await redisState()).toEqual(expectedState);
      // Some operations on the broken connection failed, alone.
      expect(expected).toContain('error');
    }
  );

  describe('a fan-out through WebSocketDelivery', () => {
    const throttle = Object.assign(new Error('rate exceeded'), {
      name: 'LimitExceededException',
      $metadata: { httpStatusCode: 429, attempts: 3 }
    });
    const gone = Object.assign(new Error('gone'), {
      name: 'GoneException',
      $metadata: { httpStatusCode: 410, attempts: 1 }
    });
    const failure = Object.assign(new Error('internal'), {
      name: 'InternalServerErrorException',
      $metadata: { httpStatusCode: 500, attempts: 3 }
    });
    const behaviours: Record<number, unknown> = {
      0: throttle,
      1: throttle,
      2: throttle,
      3: gone,
      // With connection 9's earlier one, this is the fifth throttle in a
      // minute: it pauses the endpoint and later claims are deferred.
      4: throttle,
      5: throttle,
      6: failure
    };
    const connections = 48;
    const now = 5_000_000;

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    /**
     * Sends with concurrency 16 and lets each send complete in index order,
     * one at a time, so both runs request the same operations in the same
     * order. Returns what callers and Redis see.
     */
    async function fanout(store: WebSocketDeliveryStore) {
      // Connection 7's state is unreadable, connection 9 is in cooldown.
      await breakConnection('connection-7');
      await store.claim('connection-9', 'earlier', false, now - 1_000);
      await store.finish({
        connectionId: 'connection-9',
        token: 'earlier',
        outcome: 'throttled',
        recovery: false,
        revision: 0,
        now: now - 1_000,
        jitter: 0.5
      });
      const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const delivery = new WebSocketDelivery(store);
        const gates = Array.from({ length: connections }, deferred);
        const called = Array.from({ length: connections }, deferred);
        const settled = Array.from({ length: connections }, deferred);
        const results: WebSocketDeliveryResult[] = [];
        const tally: Record<string, number> = {};
        const settlements: Promise<unknown>[] = [];
        const metrics = new DeliveryMetricsBatch();
        metrics.record = (name) => {
          tally[name] = (tally[name] ?? 0) + 1;
        };
        const batch: DeliveryBatch = {
          defer: (settlement) => settlements.push(settlement),
          metrics,
          frameType: 'DROP_UPDATE'
        };
        const sending = forEachConcurrent(
          Array.from({ length: connections }, (_, index) => index),
          async (index) => {
            results[index] = await delivery.deliver({
              connectionId: `connection-${index}`,
              message: '{"type":"DROP_UPDATE","data":{}}',
              batch,
              send: async () => {
                called[index].resolve();
                await gates[index].promise;
                const behaviour = behaviours[index];
                if (behaviour) throw behaviour;
                return { $metadata: { attempts: 1 } };
              }
            });
            settled[index].resolve();
          },
          { concurrency: 16 }
        );
        for (let index = 0; index < connections; index++) {
          await Promise.race([called[index].promise, settled[index].promise]);
          await turn();
          gates[index].resolve();
          await settled[index].promise;
          await turn();
        }
        await sending;
        await Promise.allSettled(settlements);
        return { results, tally, state: await redisState() };
      } finally {
        dateNow.mockRestore();
      }
    }

    it('matches one call per operation: partial failures, gone, and a throttle mid-batch', async () => {
      const expected = await fanout(perSend);
      await mockClient.flushDb();
      const actual = await fanout(batched);

      expect(actual.results).toEqual(expected.results);
      expect(actual.tally).toEqual(expected.tally);
      expect(actual.state).toEqual(expected.state);

      // The scenario exercised what it claims to.
      expect(expected.results[3]).toEqual({ status: 'gone' });
      expect(expected.results[6]).toEqual({ status: 'failed' });
      expect(expected.results[7]).toEqual({ status: 'sent' });
      expect(expected.results[9]).toEqual({ status: 'resync_pending' });
      expect(expected.results.slice(-10)).toEqual(
        Array(10).fill({ status: 'resync_pending' })
      );
      expect(expected.tally).toMatchObject({
        Throttled: 5,
        Gone: 1,
        Failed: 1
      });
      expect(expected.tally.Deferred).toBeGreaterThan(10);
      expect(await mockClient.get(`${deliveryScope()}:pause`)).not.toBeNull();
    });
  });

  it('sends concurrent operations in one call and splits at 64', async () => {
    const evalSha = jest.spyOn(mockClient, 'evalSha');
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          batched.claim(`connection-${index}`, 'token', false, 1_000)
        )
      );
      expect(evalSha).toHaveBeenCalledTimes(1);
      evalSha.mockClear();
      await Promise.all(
        Array.from({ length: 130 }, (_, index) =>
          batched.claim(`connection-${index}`, 'token', false, 2_000)
        )
      );
      expect(evalSha).toHaveBeenCalledTimes(3);
      evalSha.mockClear();
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          perSend.claim(`connection-${index}`, 'token', false, 3_000)
        )
      );
      expect(evalSha).toHaveBeenCalledTimes(10);
    } finally {
      evalSha.mockRestore();
    }
  });

  it('fails only the batch whose call failed', async () => {
    const evalSha = jest
      .spyOn(mockClient, 'evalSha')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      const first = Promise.allSettled(
        Array.from({ length: 3 }, (_, index) =>
          batched.claim(`connection-${index}`, 'token', false, 1_000)
        )
      );
      await turn();
      const second = Promise.allSettled(
        Array.from({ length: 3 }, (_, index) =>
          batched.claim(`connection-${index + 3}`, 'token', false, 1_000)
        )
      );
      expect((await first).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
        'rejected'
      ]);
      expect((await second).map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled'
      ]);
    } finally {
      evalSha.mockRestore();
    }
  });

  it('turns batching off with WS_DELIVERY_BATCHED_BOOKKEEPING=off', async () => {
    const evalSha = jest.spyOn(mockClient, 'evalSha');
    process.env.WS_DELIVERY_BATCHED_BOOKKEEPING = 'off';
    try {
      const store = new WebSocketDeliveryStore();
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          store.claim(`connection-${index}`, 'token', false, 1_000)
        )
      );
      expect(evalSha).toHaveBeenCalledTimes(4);
    } finally {
      delete process.env.WS_DELIVERY_BATCHED_BOOKKEEPING;
      evalSha.mockRestore();
    }
  });

  function turn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
});
