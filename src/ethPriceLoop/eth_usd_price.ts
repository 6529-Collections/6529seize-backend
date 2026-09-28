import {
  deferMissingPrices,
  getUnavailablePrices
} from './eth-price-unavailable';
import { Logger } from '@/logging';
import { priceFailureDetails, repairCause } from './eth-price-failure';
import { getHistoryChunkMs, shrinkHistoryChunk } from './eth-price-batch-size';
import {
  fetchHistoricPrices,
  fetchLivePrice,
  PRICE_INTERVAL_MS
} from './coinbase';
import { ethPriceRecoveryDb } from './eth-price-recovery.db';
import { getPriceReset, savePriceReset } from './eth-price-reset';

const logger = Logger.get('ETH_PRICE');
const MAX_CHUNKS = 8;
const RUN_BUDGET_MS = 180_000;
type RecoveryRun = {
  started: number;
  closedThrough: number;
  chunks: number;
  errors: (ReturnType<typeof priceFailureDetails> & {
    operation: string;
    first?: number;
    last?: number;
  })[];
  historyStopped: boolean;
  liveSaved: boolean;
  historyChunkMs: number;
};

function hasBudget(run: RecoveryRun): boolean {
  return (
    !run.historyStopped &&
    run.chunks < MAX_CHUNKS &&
    Date.now() - run.started < RUN_BUDGET_MS
  );
}

async function backfillGaps(run: RecoveryRun): Promise<void> {
  const unavailable = await getUnavailablePrices(run.started);
  const gaps = await ethPriceRecoveryDb.findGaps(run.started, unavailable);
  for (const gap of gaps) {
    if (!hasBudget(run)) break;
    const last = Math.min(
      Math.floor(gap.end / PRICE_INTERVAL_MS) * PRICE_INTERVAL_MS,
      run.closedThrough
    );
    const first = Math.max(
      (Math.floor(gap.start / PRICE_INTERVAL_MS) + 1) * PRICE_INTERVAL_MS,
      last - run.historyChunkMs + PRICE_INTERVAL_MS
    );
    if (first > last) continue;
    run.chunks++;
    let operation = 'gap-provider';
    try {
      const prices = await fetchHistoricPrices(first, last);
      operation = 'gap-database';
      await ethPriceRecoveryDb.repair(prices, false, run.started);
      operation = 'gap-checkpoint';
      await deferMissingPrices(prices, first, last, run.started);
      logger.info(
        `[BACKFILLED ${prices.length} ETH PRICES] [FROM ${first}] [THROUGH ${last}]`
      );
    } catch (error) {
      if (operation === 'gap-database') {
        run.historyStopped = true;
        // Persist for the next invocation; no further history runs in this one.
        await shrinkHistoryChunk(repairCause(error), first, last);
      }
      // Provider range failures may be independent. Database failures are not.
      run.errors.push({
        ...priceFailureDetails(error),
        operation,
        first,
        last
      });
    }
  }
}

async function resumeReset(reset: boolean, run: RecoveryRun): Promise<void> {
  const state = await getPriceReset(reset, run.closedThrough);
  while (state && state.next <= state.end && hasBudget(run)) {
    const last = Math.min(
      state.end,
      state.next + run.historyChunkMs - PRICE_INTERVAL_MS
    );
    run.chunks++;
    const first = state.next;
    let operation = 'reset-provider';
    try {
      const prices = await fetchHistoricPrices(first, last);
      operation = 'reset-database';
      await ethPriceRecoveryDb.repair(prices, true, run.started);
      operation = 'reset-checkpoint';
      await deferMissingPrices(prices, first, last, run.started);
      // Advance only after prices, transaction corrections and mint stats commit.
      state.next = last + PRICE_INTERVAL_MS;
      await savePriceReset(state);
      logger.info(`[ETH PRICE RESET] [NEXT ${state.next}] [END ${state.end}]`);
    } catch (error) {
      if (operation === 'reset-database') {
        run.historyStopped = true;
        // Persist for the next invocation; no further history runs in this one.
        await shrinkHistoryChunk(repairCause(error), first, last);
      }
      run.errors.push({
        ...priceFailureDetails(error),
        operation,
        first,
        last
      });
      // Reset is sequential: do not skip a failed range or run ahead of an
      // unconfirmed checkpoint. The aggregate error still fails this invocation.
      return;
    }
  }
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
    // Do not add recovery load when even the live insert cannot complete.
    if (operation === 'live-database') run.historyStopped = true;
    run.errors.push({ ...priceFailureDetails(error), operation });
  }
}

export async function syncEthUsdPrice(reset: boolean): Promise<void> {
  const started = Date.now();
  const run: RecoveryRun = {
    started,
    closedThrough:
      Math.floor((started - 60_000) / PRICE_INTERVAL_MS) * PRICE_INTERVAL_MS,
    chunks: 0,
    errors: [],
    historyStopped: false,
    liveSaved: false,
    historyChunkMs: 0
  };
  // Commit the current quote before taking any historical repair locks.
  await collectLive(run);
  if (!run.historyStopped) {
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
  if (!run.historyStopped) {
    try {
      await resumeReset(reset, run);
    } catch (error) {
      run.errors.push({ ...priceFailureDetails(error), operation: 'reset' });
    }
  }
  if (run.errors.length) {
    const summary = {
      liveSaved: run.liveSaved,
      historyStopped: run.historyStopped,
      attemptedChunks: run.chunks,
      errorCount: run.errors.length,
      failures: run.errors
    };
    const failure = new Error(
      'ETH price collection or recovery failed; incomplete work will retry next invocation'
    );
    Object.assign(failure, { recovery: summary });
    // Sharing this Error with the handler lets operational reporting deduplicate it.
    logger.error('ETH price collection or recovery failed', summary, failure);
    throw failure;
  }
}
