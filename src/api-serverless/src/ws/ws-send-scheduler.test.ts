import {
  forEachWebSocketRecipient,
  WebSocketSendScheduler,
  WS_SEND_CONCURRENCY
} from './ws-send-scheduler';
import { withLambdaRemainingTime } from '@/lambda-deadline';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('bounded WebSocket sends', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('bounds active sends and preserves per-connection order without blocking other connections', async () => {
    const scheduler = new WebSocketSendScheduler(2);
    const first = deferred();
    const second = deferred();
    const order: string[] = [];
    const send = (key: string, label: string, gate?: Promise<void>) =>
      scheduler.send(key, async () => {
        order.push(label);
        await gate;
      });
    const sends = [
      send('a', 'a1', first.promise),
      send('a', 'a2'),
      send('b', 'b1', second.promise),
      send('c', 'c1'),
      send('a', 'a3')
    ];
    expect(order).toEqual(['a1', 'b1']);
    second.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a1', 'b1', 'c1']);
    first.resolve();
    await Promise.all(sends);
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects overflow without starting another operation', async () => {
    const scheduler = new WebSocketSendScheduler(1, 1);
    const gate = deferred();
    const active = scheduler.send('a', () => gate.promise);
    const queued = scheduler.send('b', async () => undefined);
    const overflow = jest.fn();
    await expect(scheduler.send('c', overflow)).rejects.toMatchObject({
      reason: 'QUEUE_FULL'
    });
    expect(overflow).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([active, queued]);
  });

  it('expires queued work without sending it and frees the pending capacity', async () => {
    const scheduler = new WebSocketSendScheduler(1, 1);
    const gate = deferred();
    const active = scheduler.send('a', () => gate.promise);
    const operation = jest.fn();
    const queued = expect(
      scheduler.send('b', operation, 10)
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    await jest.advanceTimersByTimeAsync(10);
    await queued;
    expect(operation).not.toHaveBeenCalled();
    const replacement = scheduler.send('c', async () => undefined);
    gate.resolve();
    await Promise.all([active, replacement]);
  });

  it('holds the connection and global permit until an aborted transport settles', async () => {
    const scheduler = new WebSocketSendScheduler(1);
    const gate = deferred();
    let signal!: AbortSignal;
    const active = expect(
      scheduler.send(
        'a',
        async (value) => {
          signal = value;
          await gate.promise;
        },
        10
      )
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    const next = jest.fn(async () => undefined);
    const queued = scheduler.send('a', next);
    await jest.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([active, queued]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('checks the wall-clock deadline even before the timer callback can run', async () => {
    const scheduler = new WebSocketSendScheduler(1);
    const gate = deferred();
    const active = scheduler.send('a', () => gate.promise, 100);
    const operation = jest.fn();
    const queued = expect(
      scheduler.send('b', operation, 10)
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    jest.setSystemTime(Date.now() + 20);
    gate.resolve();
    await Promise.all([active, queued]);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reserves Lambda time and never starts when its invocation budget is exhausted', async () => {
    const scheduler = new WebSocketSendScheduler();
    const operation = jest.fn();
    await expect(
      withLambdaRemainingTime(
        () => 900,
        () => scheduler.send('a', operation)
      )
    ).rejects.toMatchObject({ reason: 'DEADLINE_EXCEEDED' });
    expect(operation).not.toHaveBeenCalled();
    const expired = withLambdaRemainingTime(
      () => 1_020,
      () =>
        scheduler.send(
          'a',
          (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true }
              );
            })
        )
    );
    const assertion = expect(expired).rejects.toMatchObject({
      reason: 'DEADLINE_EXCEEDED'
    });
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('releases slots after synchronous and asynchronous operation failures', async () => {
    const scheduler = new WebSocketSendScheduler(1);
    await expect(
      scheduler.send('a', () => {
        throw new Error('sync');
      })
    ).rejects.toThrow('sync');
    await expect(
      scheduler.send('a', async () => {
        throw new Error('async');
      })
    ).rejects.toThrow('async');
    await expect(
      scheduler.send('a', async () => undefined)
    ).resolves.toBeUndefined();
  });

  it('creates recipient work lazily and drains all recipients before surfacing a failure', async () => {
    const gate = deferred();
    const started: number[] = [];
    let settled = false;
    const sending = forEachWebSocketRecipient(
      Array.from({ length: 100 }, (_, i) => i),
      async (i) => {
        started.push(i);
        await gate.promise;
        if (i === 0) throw new Error('first failure');
      }
    );
    const assertion = expect(
      sending.finally(() => {
        settled = true;
      })
    ).rejects.toThrow('first failure');
    expect(started).toHaveLength(WS_SEND_CONCURRENCY);
    expect(settled).toBe(false);
    gate.resolve();
    await assertion;
    expect(started).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});
