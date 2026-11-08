/**
 * Fan-out claims under a frozen container or a stalled event loop: a claim
 * whose reply is already there is not failed by a late timer, and a claim
 * that really missed its deadline is never treated as held.
 */
let mockClient: {
  isReady: boolean;
  scriptLoad: jest.Mock;
  evalSha: jest.Mock;
  eval: jest.Mock;
};
jest.mock('@/redis', () => ({ getRedisClient: () => mockClient }));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() })
  }
}));

import { WebSocketDelivery } from './ws-delivery';
import { WebSocketDeliveryStore } from './ws-delivery-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushUntil(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const freeze = (ms: number) => jest.setSystemTime(Date.now() + ms);

describe('fan-out claims with late timers', () => {
  let reply: ReturnType<typeof deferred<unknown>>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 5_000_000 });
    reply = deferred<unknown>();
    mockClient = {
      isReady: true,
      scriptLoad: jest.fn().mockResolvedValue('sha'),
      evalSha: jest.fn(() => reply.promise),
      eval: jest.fn()
    };
  });
  afterEach(() => jest.useRealTimers());

  it('keeps a claim whose reply arrives after a thaw', async () => {
    const store = new WebSocketDeliveryStore(() => false);
    let claim: unknown;
    store
      .claim('connection', 'token', true, Date.now())
      .then((value) => (claim = value));
    await flushUntil(() => mockClient.evalSha.mock.calls.length === 1);
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    reply.resolve([1, 3, 0, 0, 1]);
    await flush();
    expect(claim).toEqual({
      acquired: true,
      revision: 3,
      failures: 0,
      firstFailureAt: 0,
      canReconnect: true
    });
  });

  it('keeps a batched claim whose reply arrives after a thaw', async () => {
    const store = new WebSocketDeliveryStore(() => true);
    let claim: unknown;
    store
      .claim('connection', 'token', false, Date.now())
      .then((value) => (claim = value));
    // The batch flushes in the check phase.
    jest.advanceTimersToNextTimer();
    await flushUntil(() => mockClient.evalSha.mock.calls.length === 1);
    freeze(2_000);
    jest.advanceTimersToNextTimer();
    reply.resolve([[1, 0, 0, 0, 0]]);
    await flush();
    expect(claim).toMatchObject({ acquired: true });
  });

  it('still fails a claim Redis does not answer within 250 ms', async () => {
    const store = new WebSocketDeliveryStore(() => false);
    let error: unknown;
    store
      .claim('connection', 'token', true, Date.now())
      .catch((e: unknown) => (error = e));
    await flushUntil(() => mockClient.evalSha.mock.calls.length === 1);
    jest.advanceTimersByTime(250);
    jest.runOnlyPendingTimers();
    await flush();
    expect(String(error)).toBe('Error: WebSocket recovery store timeout');
  });

  it('never treats a timed-out recovery claim as a held lease: no finish, no close', async () => {
    const delivery = new WebSocketDelivery(
      new WebSocketDeliveryStore(() => false)
    );
    const send = jest.fn().mockResolvedValue({});
    const close = jest.fn().mockResolvedValue(undefined);
    let result: unknown;
    delivery
      .deliver({
        connectionId: 'connection',
        message: '{"type":"RESYNC_REQUIRED"}',
        recovery: true,
        send,
        close
      })
      .then((value) => (result = value));
    await flushUntil(() => mockClient.evalSha.mock.calls.length === 1);
    jest.advanceTimersByTime(250);
    jest.runOnlyPendingTimers();
    await flushUntil(() => result !== undefined);
    // Delivery fails open (unchanged), but holds nothing: the only Redis
    // call is the claim; no finish releases or reschedules a lease.
    expect(result).toEqual({ status: 'sent' });
    expect(mockClient.evalSha).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    // Redis answering late changes nothing.
    reply.resolve([1, 0, 0, 0, 1]);
    await flush();
    expect(mockClient.evalSha).toHaveBeenCalledTimes(1);
  });
});
