import { EthPrice } from '@/entities/IEthPrice';
import { Logger } from '@/logging';
import {
  deferMissingPrices,
  getUnavailablePrices
} from './eth-price-unavailable';
import { priceFailureDetails, repairCause } from './eth-price-failure';
import {
  getHistoryChunkMs,
  growHistoryChunk,
  shrinkHistoryChunk
} from './eth-price-batch-size';
import {
  fetchHistoricPrices,
  fetchLivePrice,
  HISTORY_CHUNK_MS,
  PRICE_INTERVAL_MS
} from './coinbase';
import {
  ethPriceRecoveryDb,
  GAP_PAGE_SIZE,
  PriceGap
} from './eth-price-recovery.db';
import { getPriceReset, PriceReset, savePriceReset } from './eth-price-reset';

const logger = Logger.get('ETH_PRICE');
const LAMBDA_TIMEOUT_MS = 900_000;
// Each DB transaction has a 90s budget; leave another 30s for checkpoints and cleanup.
const FINISH_RESERVE_MS = 120_000;
type Range = { first: number; last: number };
type RecoveryRun = {
  started: number;
  closedThrough: number;
  remainingTime: () => number;
  chunks: number;
  committedBatches: number;
  processedCandles: number;
  missingCandles: number;
  providerPages: number;
  deferredRanges: number;
  fastBatches: number;
  lastLiveAttempt: number;
  errors: (ReturnType<typeof priceFailureDetails> & {
    operation: string;
    first?: number;
    last?: number;
  })[];
  historyStopped: boolean;
  deadlineReached: boolean;
  coverageScanComplete: boolean;
  resetPending: boolean | null;
  nextRange?: Range;
  liveSaved: boolean;
  historyChunkMs: number;
};

function hasBudget(run: RecoveryRun): boolean {
  if (run.historyStopped) return false;
  if (run.remainingTime() <= FINISH_RESERVE_MS) run.deadlineReached = true;
  return !run.deadlineReached;
}

async function collectLive(run: RecoveryRun): Promise<void> {
  let operation = 'live-provider';
  try {
    const price = await fetchLivePrice();
    operation = 'live-database';
    await ethPriceRecoveryDb.saveLive(price);
    run.liveSaved = true;
    logger.info(
      `[CURRENT ETH PRICE SAVED] [TIMESTAMP ${price.timestamp_ms}] [USD ${price.usd_price}]`
    );
  } catch (error) {
    run.fastBatches = 0;
    if (operation === 'live-database') run.historyStopped = true;
    // Continue repairs after provider failure, but preserve live-collection
    // failure visibility in the final aggregate even if history succeeds.
    run.errors.push({ ...priceFailureDetails(error), operation });
  } finally {
    // Failed live requests also wait five minutes before another attempt.
    run.lastLiveAttempt = Date.now();
  }
}

async function prepareWork(run: RecoveryRun): Promise<boolean> {
  if (!hasBudget(run)) return false;
  if (Date.now() - run.lastLiveAttempt >= PRICE_INTERVAL_MS)
    await collectLive(run);
  // Refresh latency consumes the same deadline: check again before any repair.
  return hasBudget(run);
}

async function recordFailure(
  run: RecoveryRun,
  error: unknown,
  operation: string,
  range: Range
): Promise<void> {
  run.fastBatches = 0;
  if (operation.endsWith('-database')) {
    run.historyStopped = true;
    await shrinkHistoryChunk(repairCause(error), range.first, range.last);
  }
  run.errors.push({ ...priceFailureDetails(error), operation, ...range });
}

async function recoverBatch(
  run: RecoveryRun,
  prices: EthPrice[],
  range: Range,
  state?: PriceReset
): Promise<boolean> {
  const kind = state ? 'reset' : 'gap';
  let operation = `${kind}-database`;
  const batchStarted = Date.now();
  run.chunks++;
  try {
    await ethPriceRecoveryDb.repair(prices, !!state, run.started);
    run.committedBatches += prices.length ? 1 : 0;
    run.processedCandles += prices.length;
    operation = `${kind}-checkpoint`;
    await deferMissingPrices(prices, range.first, range.last, run.started);
    // Coinbase parsing guarantees unique, in-range, grid-aligned closes.
    // Preserved DB collisions do not add samples to this provider array.
    run.missingCandles +=
      (range.last - range.first) / PRICE_INTERVAL_MS + 1 - prices.length;
    if (state) {
      // Persist the new cursor before mutating the in-memory checkpoint.
      const next = range.last + PRICE_INTERVAL_MS;
      await savePriceReset({ ...state, next });
      state.next = next;
      logger.info(`[ETH PRICE RESET] [NEXT ${state.next}] [END ${state.end}]`);
    } else {
      logger.info(
        `[ETH PRICE GAP REPAIR] [PROCESSED CANDLES ${prices.length}] [FROM ${range.first}] [THROUGH ${range.last}]`
      );
    }
    const fastFullBatch =
      prices.length * PRICE_INTERVAL_MS === run.historyChunkMs &&
      Date.now() - batchStarted < 5000;
    run.fastBatches = fastFullBatch ? run.fastBatches + 1 : 0;
    if (run.fastBatches >= 3) {
      run.historyChunkMs = await growHistoryChunk(run.historyChunkMs);
      run.fastBatches = 0;
    }
    return true;
  } catch (error) {
    await recordFailure(run, error, operation, range);
    return false;
  }
}

/** A provider page is independent of the size of each atomic database repair. */
async function recoverPage(
  run: RecoveryRun,
  page: Range,
  state?: PriceReset
): Promise<boolean> {
  run.nextRange = page;
  if (!(await prepareWork(run))) return false;
  let prices: EthPrice[];
  try {
    run.providerPages++;
    prices = await fetchHistoricPrices(page.first, page.last);
  } catch (error) {
    await recordFailure(
      run,
      error,
      `${state ? 'reset' : 'gap'}-provider`,
      page
    );
    return false;
  }
  let cursor = state ? page.first : page.last;
  while (cursor >= page.first && cursor <= page.last) {
    const range = state
      ? {
          first: cursor,
          last: Math.min(
            page.last,
            cursor + run.historyChunkMs - PRICE_INTERVAL_MS
          )
        }
      : {
          first: Math.max(
            page.first,
            cursor - run.historyChunkMs + PRICE_INTERVAL_MS
          ),
          last: cursor
        };
    run.nextRange = range;
    if (!(await prepareWork(run))) return false;
    const batch = prices.filter(
      (price) =>
        price.timestamp_ms >= range.first && price.timestamp_ms <= range.last
    );
    if (!(await recoverBatch(run, batch, range, state))) return false;
    cursor = state
      ? range.last + PRICE_INTERVAL_MS
      : range.first - PRICE_INTERVAL_MS;
  }
  return true;
}

async function recoverGap(run: RecoveryRun, gap: PriceGap): Promise<void> {
  // Existing aligned endpoints are excluded; off-grid endpoints permit the preceding close.
  let last = Math.min(
    (Math.ceil(gap.end / PRICE_INTERVAL_MS) - 1) * PRICE_INTERVAL_MS,
    run.closedThrough
  );
  const first =
    (Math.floor(gap.start / PRICE_INTERVAL_MS) + 1) * PRICE_INTERVAL_MS;
  while (last >= first) {
    const page = {
      first: Math.max(first, last - HISTORY_CHUNK_MS + PRICE_INTERVAL_MS),
      last
    };
    if (!(await recoverPage(run, page))) return;
    last = page.first - PRICE_INTERVAL_MS;
  }
}

async function backfillGaps(run: RecoveryRun): Promise<void> {
  const unavailable = await getUnavailablePrices(run.started);
  run.deferredRanges = unavailable.length;
  let before = run.started;
  while (await prepareWork(run)) {
    const gaps = await ethPriceRecoveryDb.findGaps(
      run.started,
      unavailable,
      before
    );
    for (const gap of gaps) {
      await recoverGap(run, gap);
      if (!hasBudget(run)) return;
    }
    if (gaps.length < GAP_PAGE_SIZE) {
      run.coverageScanComplete = true;
      delete run.nextRange;
      return;
    }
    // Keyset pagination visits older gaps even when a provider range fails.
    // It also prevents retrying omitted closes in a tight loop within this run.
    before = gaps[gaps.length - 1].start;
  }
}

async function resumeReset(reset: boolean, run: RecoveryRun): Promise<void> {
  const state = await getPriceReset(reset, run.closedThrough);
  run.resetPending = !!state && state.next <= state.end;
  while (state && state.next <= state.end) {
    const page = {
      first: state.next,
      last: Math.min(
        state.end,
        state.next + HISTORY_CHUNK_MS - PRICE_INTERVAL_MS
      )
    };
    if (!(await recoverPage(run, page, state))) return;
    run.resetPending = state.next <= state.end;
  }
  delete run.nextRange;
}

function reportRun(run: RecoveryRun): void {
  let stopReason = 'scan-complete';
  if (run.deadlineReached) stopReason = 'time-budget';
  if (run.errors.length) stopReason = 'failure';
  const summary = {
    stopReason,
    liveSaved: run.liveSaved,
    historyStopped: run.historyStopped,
    attemptedChunks: run.chunks,
    committedBatches: run.committedBatches,
    processedCandles: run.processedCandles,
    missingCandles: run.missingCandles,
    providerPages: run.providerPages,
    deferredRanges: run.deferredRanges,
    coverageScanComplete: run.coverageScanComplete,
    resetPending: run.resetPending,
    nextRange: run.nextRange,
    deadlineReached: run.deadlineReached,
    remainingTimeMs: run.remainingTime(),
    errorCount: run.errors.length,
    failures: run.errors
  };
  if (run.errors.length) {
    const failure = new Error(
      'ETH price collection or recovery failed; incomplete work will retry next invocation'
    );
    Object.assign(failure, { recovery: summary });
    logger.error('ETH price collection or recovery failed', summary, failure);
    throw failure;
  }
  logger.info('[ETH PRICE RECOVERY SUMMARY]', summary);
}

export async function syncEthUsdPrice(
  reset: boolean,
  remainingTime?: () => number
): Promise<void> {
  const started = Date.now();
  const run: RecoveryRun = {
    started,
    closedThrough:
      Math.floor((started - 60_000) / PRICE_INTERVAL_MS) * PRICE_INTERVAL_MS,
    remainingTime:
      remainingTime ?? (() => LAMBDA_TIMEOUT_MS - (Date.now() - started)),
    chunks: 0,
    committedBatches: 0,
    processedCandles: 0,
    missingCandles: 0,
    providerPages: 0,
    deferredRanges: 0,
    fastBatches: 0,
    lastLiveAttempt: started,
    errors: [],
    historyStopped: false,
    deadlineReached: false,
    coverageScanComplete: false,
    resetPending: null,
    liveSaved: false,
    historyChunkMs: 0
  };
  await collectLive(run);
  if (hasBudget(run)) {
    try {
      run.historyChunkMs = await getHistoryChunkMs();
      await backfillGaps(run);
    } catch (error) {
      run.historyStopped = true;
      run.errors.push({
        ...priceFailureDetails(error),
        operation: 'gap-discovery'
      });
    }
  }
  if (await prepareWork(run)) {
    try {
      await resumeReset(reset, run);
    } catch (error) {
      run.errors.push({ ...priceFailureDetails(error), operation: 'reset' });
    }
  }
  reportRun(run);
}
