import {
  deferMissingPrices,
  getUnavailablePrices
} from './eth-price-unavailable';
import { Logger } from '@/logging';
import {
  fetchHistoricPrices,
  fetchLivePrice,
  HISTORY_CHUNK_MS,
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
  errors: unknown[];
};

function hasBudget(run: RecoveryRun): boolean {
  return run.chunks < MAX_CHUNKS && Date.now() - run.started < RUN_BUDGET_MS;
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
      last - HISTORY_CHUNK_MS + PRICE_INTERVAL_MS
    );
    if (first > last) continue;
    run.chunks++;
    try {
      const prices = await fetchHistoricPrices(first, last);
      await ethPriceRecoveryDb.repair(prices, false, run.started);
      await deferMissingPrices(prices, first, last, run.started);
      logger.info(
        `[BACKFILLED ${prices.length} ETH PRICES] [FROM ${first}] [THROUGH ${last}]`
      );
    } catch (error) {
      // An unavailable range must not starve independent holes.
      run.errors.push(error);
    }
  }
}

async function resumeReset(reset: boolean, run: RecoveryRun): Promise<void> {
  const state = await getPriceReset(reset, run.closedThrough);
  while (state && state.next <= state.end && hasBudget(run)) {
    const last = Math.min(
      state.end,
      state.next + HISTORY_CHUNK_MS - PRICE_INTERVAL_MS
    );
    run.chunks++;
    const prices = await fetchHistoricPrices(state.next, last);
    await ethPriceRecoveryDb.repair(prices, true, run.started);
    await deferMissingPrices(prices, state.next, last, run.started);
    // Advance only after prices, transaction corrections and mint stats commit.
    state.next = last + PRICE_INTERVAL_MS;
    await savePriceReset(state);
    logger.info(`[ETH PRICE RESET] [NEXT ${state.next}] [END ${state.end}]`);
  }
}

export async function syncEthUsdPrice(reset: boolean): Promise<void> {
  const started = Date.now();
  const run: RecoveryRun = {
    started,
    // Allow the provider a minute to finalize a just-closed candle.
    closedThrough:
      Math.floor((started - 60_000) / PRICE_INTERVAL_MS) * PRICE_INTERVAL_MS,
    chunks: 0,
    errors: []
  };
  try {
    await backfillGaps(run);
  } catch (error) {
    run.errors.push(error);
  }
  try {
    await resumeReset(reset, run);
  } catch (error) {
    run.errors.push(error);
  }
  // Failed/long backfill never prevents attempting current collection.
  try {
    const price = await fetchLivePrice();
    await ethPriceRecoveryDb.saveLive(price);
    logger.info(
      `[CURRENT ETH PRICE SAVED] [TIMESTAMP ${price.timestamp_ms}] [USD ${price.usd_price}]`
    );
  } catch (error) {
    run.errors.push(error);
  }
  if (run.errors.length) {
    for (const error of run.errors)
      logger.error('ETH price recovery failed', error);
    const failure = new Error(
      'ETH price collection or recovery failed; incomplete work will retry next invocation'
    );
    Object.assign(failure, { cause: run.errors[0] });
    throw failure;
  }
}
