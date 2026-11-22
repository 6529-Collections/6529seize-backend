import { Logger } from '@/logging';
import {
  ChainDayStepRunner,
  ChainTdhIngestResult,
  runFollowUpSteps
} from './chain-tdh-ingest';
import {
  CHAIN_DAY_STEPS,
  ChainDayStep,
  TABLE_READING_STEPS,
  TdhChainDayMode,
  TdhChainDayRow
} from './tdh-chain-days.db';
import { readChainDay, TdhChainSource } from './tdh-chain-source';
import { TdhChainDay, TdhChainDayInfo } from './tdh-chain.types';

/**
 * "The chain applied day N": the replacement for the 00:01 start. Every few
 * minutes the poller reads the newest final TDH day from the gateway and
 * takes it in:
 *
 * - a day `planDay` picks is ingested first, even while an older day's
 *   follow-up steps are still due. Its alerts go out as soon as it is
 *   written, then its steps run. The older day's steps that read the TDH
 *   tables are given up (the newer day's own steps redo them), with an
 *   alert; its day files can still be published.
 * - otherwise, in CHAIN, the follow-up steps still due are run, oldest day
 *   first. A failing step never holds back a later day.
 *
 * In CHAIN mode it also raises an alert, once an hour, while the newest
 * TDH day in the tables (`tdh_blocks`) is more than 30 hours old: the
 * site's TDH is late however the gateway or the chain is failing.
 */

const logger = Logger.get('TDH_CHAIN_DAY_POLLER');

/** The newest TDH day may be this old before an alert. */
export const STALE_AFTER_MS = 30 * 60 * 60 * 1000;

export interface PollerDeps {
  readonly mode: TdhChainDayMode | null;
  readonly source: TdhChainSource;
  latestRow(): Promise<TdhChainDayRow | null>;
  /** CHAIN days with follow-up steps still due, oldest first. */
  pendingDays(): Promise<TdhChainDayRow[]>;
  /** When the newest TDH day in the tables was taken (ms), or null. */
  latestTdhBlockTime(): Promise<number | null>;
  keyWidth(): Promise<number>;
  ingest(
    day: TdhChainDay,
    mode: TdhChainDayMode
  ): Promise<ChainTdhIngestResult>;
  readonly steps: ChainDayStepRunner;
  alert(title: string, message: string): Promise<void>;
  now(): number;
}

/**
 * The day to ingest, or null:
 * - nothing recorded yet: the newest day (no backfill);
 * - a newer day than the last record: the next day, or the newest when more
 *   than one day is missing (the site jumps to the newest day rather than
 *   replay the gap; history runs only where the day before is present);
 * - the last record FAILED and nothing newer: that day again;
 * - CHAIN, the last record WRITTEN or INGESTED with deferred keys that now
 *   fit the columns, and nothing newer: that day again.
 * A shadowed day is never written again when CHAIN mode starts: the site
 * already holds it, and writing it again would announce it twice.
 */
export function planDay(
  last: TdhChainDayRow | null,
  newest: number,
  mode: TdhChainDayMode,
  keyWidth: number
): number | null {
  if (!last) return newest;
  if (newest > last.cycleDay) {
    return newest - last.cycleDay > 1 ? newest : last.cycleDay + 1;
  }
  if (newest < last.cycleDay) return null;
  if (last.status === 'FAILED') return last.cycleDay;
  if (
    mode === 'CHAIN' &&
    last.mode === 'CHAIN' &&
    last.deferredKeys.length > 0 &&
    last.deferredKeys.every((k) => k.length <= keyWidth)
  ) {
    return last.cycleDay;
  }
  return null;
}

/** Whether the gateway says the day's apply block is final. */
export function isFinal(info: TdhChainDayInfo): boolean {
  const { applyHeight, finalizedHeight } = info.apply;
  if (applyHeight === null || finalizedHeight === null) return true;
  return applyHeight <= finalizedHeight;
}

export interface PollOutcome {
  readonly ingested?: { cycleDay: number; result: ChainTdhIngestResult };
  /** The days whose follow-up steps ran. */
  readonly stepsRun?: readonly number[];
}

async function alertIfStale(deps: PollerDeps): Promise<void> {
  const now = deps.now();
  const minute = new Date(now).getUTCMinutes();
  // Once an hour: the :15 run is in both schedules.
  if (minute < 15 || minute >= 20) return;
  const newest = await deps.latestTdhBlockTime();
  if (newest === null) return;
  const since = now - newest;
  if (since > STALE_AFTER_MS) {
    await deps.alert(
      'TDH from the 6529 chain is late',
      `the newest TDH day in the tables was taken ${Math.floor(since / 3_600_000)} h ago`
    );
  }
}

/** The day planned and read from the gateway, or null. */
async function dayToIngest(
  deps: PollerDeps & { mode: TdhChainDayMode },
  last: TdhChainDayRow | null
): Promise<TdhChainDay | null> {
  let newest: TdhChainDayInfo | null;
  try {
    newest = await deps.source.latestDay();
  } catch (e) {
    logger.warn(`[GATEWAY UNREACHABLE] [${(e as Error).message}]`);
    return null;
  }
  if (!newest) {
    logger.info('[NO APPLIED TDH DAY ON THE GATEWAY]');
    return null;
  }
  if (!isFinal(newest)) {
    logger.info(`[DAY ${newest.header.cycleDay} NOT FINAL YET]`);
    return null;
  }
  const width =
    deps.mode === 'CHAIN' && last && last.deferredKeys.length > 0
      ? await deps.keyWidth()
      : 0;
  const cycleDay = planDay(last, newest.header.cycleDay, deps.mode, width);
  if (cycleDay === null) {
    logger.info(`[UP TO DATE] [DAY ${newest.header.cycleDay}]`);
    return null;
  }
  try {
    const day = await readChainDay(deps.source, cycleDay);
    if (!day) logger.warn(`[DAY ${cycleDay} NOT SERVED]`);
    return day;
  } catch (e) {
    logger.warn(`[DAY ${cycleDay} NOT READ] [${(e as Error).message}]`);
    return null;
  }
}

/** The day's alerts, sent before any follow-up step runs. */
async function alertOnResult(
  deps: PollerDeps,
  cycleDay: number,
  result: ChainTdhIngestResult,
  failedBefore: boolean
): Promise<void> {
  if (result.status === 'FAILED' && !failedBefore) {
    await deps.alert(
      `TDH day ${cycleDay} from the 6529 chain failed its checks`,
      JSON.stringify(result.summary.failures.slice(0, 5))
    );
  }
  if (result.verdict === 'MISMATCH') {
    await deps.alert(
      `TDH day ${cycleDay}: the site and the 6529 chain differ (${deps.mode})`,
      JSON.stringify({
        cache: result.summary.cache?.counts,
        live: result.summary.live
      })
    );
  }
  if (result.deferredKeys.length > 0) {
    await deps.alert(
      `TDH day ${cycleDay}: ${result.deferredKeys.length} consolidations wait for wider key columns`,
      `${result.deferredKeys.length} keys longer than the consolidation_key columns`
    );
  }
}

/**
 * Day `cycleDay` was just written: older days still due their table steps
 * can't run them any more. They are given up, with an alert naming them.
 */
async function giveUpOlderTableSteps(
  deps: PollerDeps,
  pending: readonly TdhChainDayRow[],
  cycleDay: number
): Promise<void> {
  for (const older of pending) {
    if (older.cycleDay >= cycleDay) continue;
    const moot: ChainDayStep[] = TABLE_READING_STEPS.filter(
      (s) => !older.stepsDone.includes(s) && !older.stepsGivenUp.includes(s)
    );
    if (moot.length === 0) continue;
    await deps.steps.giveUp(older.cycleDay, moot);
    await deps.alert(
      `TDH day ${older.cycleDay}: ${moot.join(', ')} left undone`,
      `day ${cycleDay} was written first, and these steps read the TDH tables, which now hold day ${cycleDay}`
    );
  }
}

/** Runs the follow-up steps still due, oldest day first. */
async function runPendingSteps(deps: PollerDeps): Promise<number[]> {
  const stepsRun: number[] = [];
  for (const pending of await deps.pendingDays()) {
    const due = CHAIN_DAY_STEPS.filter(
      (s) => !pending.stepsDone.includes(s) && !pending.stepsGivenUp.includes(s)
    );
    logger.info(`[DAY ${pending.cycleDay}] [STEPS DUE ${due.join(', ')}]`);
    await runFollowUpSteps(pending, deps.steps, (title, message) =>
      deps.alert(title, message)
    );
    stepsRun.push(pending.cycleDay);
  }
  return stepsRun;
}

export async function pollChainDays(deps: PollerDeps): Promise<PollOutcome> {
  const mode = deps.mode;
  if (!mode) {
    logger.info('[OFF] [neither TDH chain flag is on]');
    return {};
  }
  if (mode === 'CHAIN') {
    await alertIfStale(deps);
  }
  const last = await deps.latestRow();
  const day = await dayToIngest({ ...deps, mode }, last);
  let ingested: PollOutcome['ingested'];
  if (day) {
    const cycleDay = day.header.cycleDay;
    const pendingBefore = mode === 'CHAIN' ? await deps.pendingDays() : [];
    let result: ChainTdhIngestResult;
    try {
      result = await deps.ingest(day, mode);
    } catch (e) {
      // The steps still due don't wait on a day that can't be taken in.
      if (mode === 'CHAIN') await runPendingSteps(deps);
      throw e;
    }
    logger.info(
      `[DAY ${cycleDay}] [${mode}] [${result.status}] [${result.verdict ?? '-'}]`
    );
    const failedBefore =
      last?.cycleDay === cycleDay &&
      (last.status === 'FAILED' || last.redoFailed);
    await alertOnResult(deps, cycleDay, result, failedBefore);
    ingested = { cycleDay, result };
    if (result.status === 'WRITTEN') {
      await giveUpOlderTableSteps(deps, pendingBefore, cycleDay);
      await runFollowUpSteps(
        {
          cycleDay,
          block: day.header.cutoffNumber,
          stepsDone: [],
          stepsGivenUp: []
        },
        deps.steps,
        (title, message) => deps.alert(title, message)
      );
      return { ingested, stepsRun: [cycleDay] };
    }
    if (result.status === 'INGESTED') {
      // A SHADOW computation: enough for one run.
      return { ingested };
    }
  }
  if (mode !== 'CHAIN') return ingested ? { ingested } : {};
  const stepsRun = await runPendingSteps(deps);
  return { ...(ingested ? { ingested } : {}), stepsRun };
}
