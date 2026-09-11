import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@/logging';

const storage = new AsyncLocalStorage<NftLinkResolutionBudget>();
const logger = Logger.get('NFT_LINK_RESOLUTION');
export const NFT_LINK_RPC_TIMEOUT_MS = 5000;
export const NFT_LINK_RESOLUTION_TIMEOUT_MS = 90_000;
export const NFT_LINK_CLEANUP_RESERVE_MS = 10_000;

export class NftLinkResolutionDeadlineError extends Error {
  constructor() {
    super('NFT link resolution deadline exceeded');
    Object.setPrototypeOf(this, NftLinkResolutionDeadlineError.prototype);
  }
}

/** Scoped to the refresher; other users of the shared resolver keep their policy. */
export class NftLinkResolutionBudget {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cleanups: Array<() => void> = [];

  constructor(timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new NftLinkResolutionDeadlineError();
    }
    this.deadline = Date.now() + timeoutMs;
    this.timer = setTimeout(() => this.expire(), timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  check(): void {
    if (this.signal.aborted || this.remainingMs() <= 0) {
      this.expire();
      throw new NftLinkResolutionDeadlineError();
    }
  }

  private expire(): void {
    if (!this.signal.aborted) {
      logger.warn({ event: 'resolution_deadline_exceeded' });
      this.controller.abort();
    }
  }

  addCleanup(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  async waitToRetry(delayMs: number): Promise<void> {
    this.check();
    if (this.remainingMs() <= delayMs + NFT_LINK_RPC_TIMEOUT_MS) {
      this.expire();
      throw new NftLinkResolutionDeadlineError();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, delayMs);
        onAbort = () => reject(new NftLinkResolutionDeadlineError());
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) this.signal.removeEventListener('abort', onAbort);
    }
    this.check();
  }

  dispose(): void {
    clearTimeout(this.timer);
    // Also cancel any parallel adapter reads left behind by a rejected promise.
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
  }
}

export function getNftLinkResolutionBudget():
  | NftLinkResolutionBudget
  | undefined {
  return storage.getStore();
}

export async function withNftLinkResolutionBudget<T>(
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  const budget = new NftLinkResolutionBudget(timeoutMs);
  try {
    return await storage.run(budget, operation);
  } finally {
    budget.dispose();
  }
}

/** Observe DB/notification stages without abandoning or racing their writes. */
export async function nftLinkResolutionStage<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const budget = getNftLinkResolutionBudget();
  if (!budget) return operation();
  const startedAt = Date.now();
  logger.info({ stage, event: 'start', remaining_ms: budget.remainingMs() });
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    logger.info({
      stage,
      event: succeeded ? 'success' : 'failure',
      elapsed_ms: Date.now() - startedAt,
      remaining_ms: budget.remainingMs()
    });
  }
}

/** For read-only notification data. A late result cannot start any side effects. */
export async function nftLinkNotificationRead<T>(
  operation: () => Promise<T>
): Promise<T> {
  const budget = getNftLinkResolutionBudget();
  if (!budget) return operation();
  budget.check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('NFT link notification data read timed out')),
          Math.min(5000, budget.remainingMs())
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
