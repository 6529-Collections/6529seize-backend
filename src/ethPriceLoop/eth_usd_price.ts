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
  DAILY_PRICE_INTERVAL_MS,
  FIVE_MINUTE_HISTORY_START_MS,
  HISTORY_START_MS,
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
  state?: PriceReset,
  intervalMs = PRICE_INTERVAL_MS
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
    if (intervalMs === DAILY_PRICE_INTERVAL_MS) {
      await deferMissingPrices(
        prices,
        range.first,
        range.last,
        run.started,
        intervalMs
      );
    } else {
      await deferMissingPrices(prices, range.first, range.last, run.started);
    }
    // Coinbase parsing guarantees unique, in-range, grid-aligned closes.
    // Preserved DB collisions do not add samples to this provider array.
    // Count provider candles (daily or five-minute), not missing elapsed time.
    run.missingCandles +=
      (range.last - range.first) / intervalMs + 1 - prices.length;
    if (state) {
      // Persist the new cursor before mutating the in-memory checkpoint.
      // A legacy reset may end mid-day before 2026. Keep its terminal cursor
      // within the persisted checkpoint contract (end plus one five-minute slot).
      const next = Math.min(
        range.last + intervalMs,
        state.end + PRICE_INTERVAL_MS
      );
      await savePriceReset({ ...state, next });
      state.next = next;
      logger.info(`[ETH PRICE RESET] [NEXT ${state.next}] [END ${state.end}]`);
    } else {
      logger.info(
        `[ETH PRICE GAP REPAIR] [INTERVAL_MS ${intervalMs}] [PROCESSED CANDLES ${prices.length}] [FROM ${range.first}] [THROUGH ${range.last}]`
      );
    }
    const fastFullBatch =
      intervalMs === PRICE_INTERVAL_MS &&
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
  state?: PriceReset,
  intervalMs = PRICE_INTERVAL_MS
): Promise<boolean> {
  run.nextRange = page;
  if (!(await prepareWork(run))) return false;
  let prices: EthPrice[];
  const kind = state ? 'reset' : 'gap';
  try {
    run.providerPages++;
    prices =
      intervalMs === DAILY_PRICE_INTERVAL_MS
        ? await fetchHistoricPrices(
            page.first,
            page.last,
            run.started,
            intervalMs
          )
        : await fetchHistoricPrices(page.first, page.last);
  } catch (error) {
    await recordFailure(run, error, `${kind}-provider`, page);
    return false;
  }
  let cursor = state ? page.first : page.last;
  while (cursor >= page.first && cursor <= page.last) {
    const chunkMs = Math.max(intervalMs, run.historyChunkMs);
    const range = state
      ? {
          first: cursor,
          last: Math.min(page.last, cursor + chunkMs - intervalMs)
        }
      : {
          first: Math.max(page.first, cursor - chunkMs + intervalMs),
          last: cursor
        };
    run.nextRange = range;
    if (!(await prepareWork(run))) return false;
    const batch = prices.filter(
      (price) =>
        price.timestamp_ms >= range.first && price.timestamp_ms <= range.last
    );
    if (!(await recoverBatch(run, batch, range, state, intervalMs)))
      return false;
    cursor = state ? range.last + intervalMs : range.first - intervalMs;
  }
  return true;
}

async function recoverGap(
  run: RecoveryRun,
  gap: PriceGap,
  intervalMs = PRICE_INTERVAL_MS
): Promise<void> {
  const daily = intervalMs === DAILY_PRICE_INTERVAL_MS;
  // Existing endpoints are excluded; the cutoff sentinel admits the first close.
  let last = Math.min(
    (Math.ceil(gap.end / intervalMs) - 1) * intervalMs,
    daily ? FIVE_MINUTE_HISTORY_START_MS - intervalMs : run.closedThrough
  );
  const first = Math.max(
    daily ? HISTORY_START_MS : FIVE_MINUTE_HISTORY_START_MS,
    (Math.floor(gap.start / intervalMs) + 1) * intervalMs
  );
  // Thirty daily candles is an operational page size, not Coinbase's limit.
  const pageMs = daily ? 30 * intervalMs : HISTORY_CHUNK_MS;
  while (last >= first) {
    const page = { first: Math.max(first, last - pageMs + intervalMs), last };
    if (!(await recoverPage(run, page, undefined, intervalMs))) return;
    last = page.first - intervalMs;
  }
}

async function backfillGaps(run: RecoveryRun, daily = false): Promise<void> {
  const intervalMs = daily ? DAILY_PRICE_INTERVAL_MS : PRICE_INTERVAL_MS;
  const unavailable = daily
    ? await getUnavailablePrices(run.started, intervalMs)
    : await getUnavailablePrices(run.started);
  run.deferredRanges += unavailable.length;
  let before = run.started;
  while (await prepareWork(run)) {
    const findGaps = daily
      ? ethPriceRecoveryDb.findDailyGaps.bind(ethPriceRecoveryDb)
      : ethPriceRecoveryDb.findGaps.bind(ethPriceRecoveryDb);
    const gaps = await findGaps(run.started, unavailable, before);
    for (const gap of gaps) {
      await recoverGap(run, gap, intervalMs);
      if (!hasBudget(run)) return;
    }
    if (gaps.length < GAP_PAGE_SIZE) {
      run.coverageScanComplete = daily;
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
    const daily = state.next < FIVE_MINUTE_HISTORY_START_MS;
    const intervalMs = daily ? DAILY_PRICE_INTERVAL_MS : PRICE_INTERVAL_MS;
    // Resume old five-minute checkpoints at the containing day; upserts are repeatable.
    const first = daily
      ? Math.floor(state.next / intervalMs) * intervalMs
      : state.next;
    const page = {
      first,
      last: Math.min(
        Math.floor(state.end / intervalMs) * intervalMs,
        daily ? FIVE_MINUTE_HISTORY_START_MS - intervalMs : state.end,
        first + (daily ? 30 * intervalMs : HISTORY_CHUNK_MS) - intervalMs
      )
    };
    if (!(await recoverPage(run, page, state, intervalMs))) return;
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
      if (await prepareWork(run)) await backfillGaps(run, true);
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
