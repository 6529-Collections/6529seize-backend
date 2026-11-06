import fc from 'fast-check';
import {
  DropBroadcastCoalescer,
  DropBroadcastLeaseStore,
  DropBroadcastOutcome,
  DropBroadcastPhase,
  readDropBroadcastCoalesceWindowMs
} from './drop-broadcast-coalescer';

/**
 * A virtual clock with timers, so concurrent invocations interleave the way
 * separate Lambda invocations would, without real waiting.
 */
class VirtualTime {
  now = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.timers.push({ at: this.now + ms, seq: this.seq++, resolve });
    });

  at(time: number, action: () => void): void {
    this.timers.push({
      at: time,
      seq: this.seq++,
      resolve: action
    });
  }

  async run(): Promise<void> {
    await settle();
    while (this.timers.length) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.now = Math.max(this.now, next.at);
      next.resolve();
      await settle();
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeLeaseStore implements DropBroadcastLeaseStore {
  readonly leases = new Map<string, { token: string; expiresAt: number }>();
  available = true;

  constructor(private readonly clock: { now: number }) {}

  private live(key: string) {
    const lease = this.leases.get(key);
    if (lease && lease.expiresAt <= this.clock.now) {
      this.leases.delete(key);
      return undefined;
    }
    return lease;
  }

  async acquire(key: string, token: string, ttlMs: number) {
    if (!this.available) return null;
    if (this.live(key)) return false;
    this.leases.set(key, { token, expiresAt: this.clock.now + ttlMs });
    return true;
  }

  async isHeld(key: string) {
    if (!this.available) return null;
    return this.live(key) !== undefined;
  }

  async remainingMs(key: string) {
    if (!this.available) return null;
    const lease = this.live(key);
    return lease ? lease.expiresAt - this.clock.now : 0;
  }

  async release(key: string, token: string) {
    if (this.live(key)?.token === token) this.leases.delete(key);
  }
}

function setup(windowMs = 250) {
  const time = new VirtualTime();
  const store = new FakeLeaseStore(time);
  const coalescer = new DropBroadcastCoalescer(
    store,
    () => windowMs,
    time.sleep
  );
  const sends: { phase: DropBroadcastPhase; at: number; dropId: string }[] = [];
  const update = (dropId = 'drop-1') =>
    coalescer.broadcast({
      kind: 'REACTION',
      dropId,
      send: async (phase) => {
        sends.push({ phase, at: time.now, dropId });
      }
    });
  return { time, store, coalescer, sends, update };
}

describe('DropBroadcastCoalescer', () => {
  it('sends at once when coalescing is disabled', async () => {
    const { update, sends } = setup(0);

    await expect(update()).resolves.toBe('immediate');
    await expect(update()).resolves.toBe('immediate');

    expect(sends.map((it) => it.phase)).toEqual(['immediate', 'immediate']);
  });

  it('sends at once when the lease store is unavailable', async () => {
    const { update, sends, store } = setup();
    store.available = false;

    await expect(update()).resolves.toBe('immediate');
    await expect(update()).resolves.toBe('immediate');

    expect(sends).toHaveLength(2);
  });

  it('sends the first update in a quiet period at once', async () => {
    const { update, sends } = setup();

    await expect(update()).resolves.toBe('leading');

    expect(sends).toEqual([{ phase: 'leading', at: 0, dropId: 'drop-1' }]);
  });

  it('folds a burst into one leading and one trailing send', async () => {
    const { time, update, sends } = setup();
    const outcomes: DropBroadcastOutcome[] = [];
    for (const at of [0, 20, 40, 60, 80]) {
      time.at(at, () => {
        void update().then((outcome) => outcomes.push(outcome));
      });
    }

    await time.run();

    expect(outcomes.filter((it) => it === 'coalesced')).toHaveLength(3);
    expect(sends.map((it) => [it.phase, it.at])).toEqual([
      ['leading', 0],
      ['trailing', 250]
    ]);
  });

  it('keeps drops independent', async () => {
    const { time, update, sends } = setup();
    time.at(0, () => void update('drop-1'));
    time.at(10, () => void update('drop-2'));

    await time.run();

    expect(sends.map((it) => [it.dropId, it.phase])).toEqual([
      ['drop-1', 'leading'],
      ['drop-2', 'leading']
    ]);
  });

  it('broadcasts again after the window closes', async () => {
    const { time, update, sends } = setup();
    time.at(0, () => void update());
    time.at(300, () => void update());

    await time.run();

    expect(sends.map((it) => [it.phase, it.at])).toEqual([
      ['leading', 0],
      ['leading', 300]
    ]);
  });

  it('starts a new flush for an update that lands while the trailing send runs', async () => {
    const time = new VirtualTime();
    const store = new FakeLeaseStore(time);
    const coalescer = new DropBroadcastCoalescer(store, () => 250, time.sleep);
    const sends: [DropBroadcastPhase, number][] = [];
    const update = () =>
      coalescer.broadcast({
        kind: 'RATING',
        dropId: 'drop-1',
        send: async (phase) => {
          sends.push([phase, time.now]);
          // The trailing read and fan-out take 100 ms.
          if (phase === 'trailing') await time.sleep(100);
        }
      });
    time.at(0, () => void update());
    time.at(50, () => void update());
    // Lands while the first trailing send is still running.
    time.at(300, () => void update());

    await time.run();

    expect(sends).toEqual([
      ['leading', 0],
      ['trailing', 250],
      ['trailing', 500]
    ]);
  });

  it('never loses an update: each one is covered by a send that starts after it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 2_000 }), {
          minLength: 1,
          maxLength: 40
        }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 150 }),
        async (commitTimes, windowMs, sendDurationMs) => {
          const time = new VirtualTime();
          const store = new FakeLeaseStore(time);
          const coalescer = new DropBroadcastCoalescer(
            store,
            () => windowMs,
            time.sleep
          );
          // A send reads the drop's state when it starts.
          const readTimes: number[] = [];
          for (const at of commitTimes) {
            time.at(at, () => {
              void coalescer.broadcast({
                kind: 'REACTION',
                dropId: 'drop-1',
                send: async () => {
                  readTimes.push(time.now);
                  if (sendDurationMs) await time.sleep(sendDurationMs);
                }
              });
            });
          }

          await time.run();

          for (const at of commitTimes) {
            expect(readTimes.some((readAt) => readAt >= at)).toBe(true);
          }
          expect(readTimes.length).toBeLessThanOrEqual(commitTimes.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('sends at most about one broadcast per window under a sustained burst', async () => {
    const { time, update, sends } = setup(250);
    for (let at = 0; at < 2_000; at += 10) {
      time.at(at, () => void update());
    }

    await time.run();

    // 200 updates over 2 s: one leading send, then one per window.
    expect(sends.length).toBeGreaterThanOrEqual(8);
    expect(sends.length).toBeLessThanOrEqual(10);
  });
});

describe('readDropBroadcastCoalesceWindowMs', () => {
  const previous = process.env.WS_DROP_UPDATE_COALESCE_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.WS_DROP_UPDATE_COALESCE_MS;
    else process.env.WS_DROP_UPDATE_COALESCE_MS = previous;
  });

  it('defaults to 250 ms', () => {
    delete process.env.WS_DROP_UPDATE_COALESCE_MS;
    expect(readDropBroadcastCoalesceWindowMs()).toBe(250);
  });

  it('can be switched off with 0', () => {
    process.env.WS_DROP_UPDATE_COALESCE_MS = '0';
    expect(readDropBroadcastCoalesceWindowMs()).toBe(0);
  });

  it('clamps out-of-range values', () => {
    process.env.WS_DROP_UPDATE_COALESCE_MS = '-5';
    expect(readDropBroadcastCoalesceWindowMs()).toBe(0);
    process.env.WS_DROP_UPDATE_COALESCE_MS = '999999';
    expect(readDropBroadcastCoalesceWindowMs()).toBe(2_000);
  });
});
