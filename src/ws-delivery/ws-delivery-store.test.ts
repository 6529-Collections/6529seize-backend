import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { createClient } from 'redis';
import {
  deliveryScope,
  connectionHash,
  WebSocketDeliveryStore
} from './ws-delivery-store';

let mockClient: ReturnType<typeof createClient>;
jest.mock('@/redis', () => ({ getRedisClient: () => mockClient }));

describe('shared WebSocket recovery in real Redis', () => {
  let container: StartedTestContainer;
  const originalEndpoint = process.env.API_GATEWAY_WS_ENDPOINT;
  const firstWorker = new WebSocketDeliveryStore();
  const secondWorker = new WebSocketDeliveryStore();
  const now = 1_000_000;

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
  });
  const finish = (
    token: string,
    outcome: 'sent' | 'throttled' | 'gone' | 'failed',
    time = now,
    recovery = false,
    revision = 0
  ) =>
    firstWorker.finish({
      connectionId: 'connection-1',
      token,
      outcome,
      now: time,
      recovery,
      revision,
      jitter: 0.5
    });

  it('shares cooldown across independent Lambda instances and retains one refresh marker', async () => {
    await firstWorker.claim('connection-1', 'worker-a', false, now);
    await expect(finish('worker-a', 'throttled')).resolves.toBe(true);
    for (let i = 0; i < 18; i++) {
      const claim = await secondWorker.claim(
        'connection-1',
        `worker-b-${i}`,
        false,
        now + 1000
      );
      expect(claim.acquired).toBe(false);
    }
    expect(await firstWorker.due(now + 29_999)).toEqual([]);
    expect(await secondWorker.due(now + 30_000)).toEqual(['connection-1']);
    const snapshot = await firstWorker.snapshot(now + 1000);
    expect(snapshot).toMatchObject({
      attempted: 1,
      throttled: 1,
      deferred: 18,
      connections: 1,
      throttledConnections: 1,
      pending: 1,
      oldestFailureAt: now
    });
    const claim = await secondWorker.claim(
      'connection-1',
      'retry',
      true,
      now + 30_000
    );
    await finish('retry', 'sent', now + 30_000, true, claim.revision);
    expect(await firstWorker.due(now + 60_000)).toEqual([]);
    expect(await firstWorker.snapshot(now + 60_000)).toMatchObject({
      pending: 0,
      oldestFailureAt: 0,
      healthyConnections: 1
    });
    expect(
      await firstWorker.snapshot(now + 60_000, 'connection-1')
    ).toMatchObject({ healthyConnections: 0, recentlyHealthyConnections: 0 });
  });
  it('keeps a refresh queued when another producer races with a successful retry', async () => {
    await firstWorker.claim('connection-1', 'initial', false, now);
    await finish('initial', 'throttled');
    const claim = await firstWorker.claim(
      'connection-1',
      'retry',
      true,
      now + 30_000
    );
    await secondWorker.claim('connection-1', 'concurrent', false, now + 30_001);
    await finish('retry', 'sent', now + 30_002, true, claim.revision);
    expect(await firstWorker.due(now + 60_000)).toEqual(['connection-1']);
  });
  it('does not let a late completion delete a newer lease or pending work', async () => {
    await firstWorker.claim('connection-1', 'initial', false, now);
    await finish('initial', 'throttled');
    await firstWorker.claim('connection-1', 'old', true, now + 30_000);
    await secondWorker.claim('connection-1', 'new', true, now + 60_001);
    await finish('old', 'gone', now + 60_002, true);
    expect(
      await mockClient.hGet(
        `${deliveryScope()}:connection:${connectionHash('connection-1')}`,
        'leaseToken'
      )
    ).toBe('new');
  });
  it('backs off failed retries so one denied request cannot loop in the same run', async () => {
    await firstWorker.claim('connection-1', 'first', false, now);
    await finish('first', 'throttled');
    const claim = await firstWorker.claim(
      'connection-1',
      'retry',
      true,
      now + 30_000
    );
    await finish('retry', 'failed', now + 30_000, true, claim.revision);
    expect(await firstWorker.due(now + 30_001)).toEqual([]);
    expect(await firstWorker.due(now + 90_000)).toEqual(['connection-1']);
  });
  it('keeps normal foreground delivery concurrent until a connection throttles', async () => {
    await firstWorker.claim('connection-1', 'first', false, now);
    expect(
      (await secondWorker.claim('connection-1', 'second', false, now + 1))
        .acquired
    ).toBe(true);
    await finish('first', 'sent', now + 2);
    expect(await firstWorker.due(now + 2)).toEqual([]);
  });
  it('separates API endpoints and removes queued work when a listener is gone', async () => {
    await firstWorker.claim('connection-1', 'first', false, now);
    await finish('first', 'throttled');
    process.env.API_GATEWAY_WS_ENDPOINT = 'https://other-api.invalid/staging';
    expect(await secondWorker.due(now + 60_000)).toEqual([]);
    process.env.API_GATEWAY_WS_ENDPOINT =
      'https://synthetic-api.invalid/production';
    await firstWorker.forget('connection-1');
    expect(await firstWorker.due(now + 60_000)).toEqual([]);
    expect(
      await mockClient.exists(
        `${deliveryScope()}:connection:${connectionHash('connection-1')}`
      )
    ).toBe(0);
  });
});
