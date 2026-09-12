import { performance } from 'node:perf_hooks';

export const COLLECTING_REQUEST_BUDGET_MS = 20000;

export class CollectingWorkTimeout extends Error {
  constructor() {
    super('The collecting analysis exceeded its work budget.');
    this.name = 'CollectingWorkTimeout';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Monotonic elapsed work, independent of the wall clock used for order expiry. */
export class CollectingWorkBudget {
  private readonly deadline: number;
  private timedOut = false;

  constructor(
    durationMs = COLLECTING_REQUEST_BUDGET_MS,
    private readonly clock: () => number = () => performance.now()
  ) {
    this.deadline = clock() + Math.max(0, durationMs);
  }

  remainingMs(): number {
    return this.timedOut ? 0 : Math.max(0, this.deadline - this.clock());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  assertAvailable(): void {
    if (this.expired()) throw new CollectingWorkTimeout();
  }

  child(durationMs: number, reserveMs = 0): CollectingWorkBudget {
    return new CollectingWorkBudget(
      Math.min(durationMs, this.remainingMs() - reserveMs),
      this.clock
    );
  }

  /** Bounds waiting; it does not claim to cancel a database/RPC request. */
  async waitFor<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          this.assertAvailable();
          const value = await work();
          // Never allow a late read to start the caller's synchronous parsing.
          this.assertAvailable();
          return value;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Node may truncate fractional timer delays. Once a wait times
            // out, this budget must remain expired even before that fraction elapses.
            this.timedOut = true;
            reject(new CollectingWorkTimeout());
          }, this.remainingMs());
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
