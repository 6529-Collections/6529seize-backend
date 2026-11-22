import { Logger } from '@/logging';
import { ChainTdhIngestResult, runFollowUpSteps } from './chain-tdh-ingest';
import { ChainDayStepRunner } from './chain-tdh-ingest';
import { TdhChainDayMode, TdhChainDayRow } from './tdh-chain-days.db';
import { readChainDay, TdhChainSource } from './tdh-chain-source';
import { TdhChainDay, TdhChainDayInfo } from './tdh-chain.types';

/**
 * "The chain applied day N": the replacement for the 00:01 start. Every few
 * minutes the poller reads the newest final TDH day from the gateway and
 * takes it in. One thing a run, since a day is a full TDH computation:
 *
 * - CHAIN, and the newest record is WRITTEN: resume its follow-up steps;
 * - otherwise ingest the day `planDay` picks, if any.
 *
 * In CHAIN mode it also raises an alert, once an hour, while the newest day
 * written is more than 30 hours past its boundary: the site's TDH is late
 * however the gateway or the chain is failing.
 */

const logger = Logger.get('TDH_CHAIN_DAY_POLLER');

/** The newest day written may lag its boundary this long before an alert. */
export const STALE_AFTER_MS = 30 * 60 * 60 * 1000;

export interface PollerDeps {
  readonly mode: TdhChainDayMode | null;
  readonly source: TdhChainSource;
  latestRow(): Promise<TdhChainDayRow | null>;
  latestWritten(): Promise<TdhChainDayRow | null>;
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
  readonly resumed?: number;
  readonly ingested?: { cycleDay: number; result: ChainTdhIngestResult };
}

async function alertIfStale(deps: PollerDeps): Promise<void> {
  const written = await deps.latestWritten();
  const now = deps.now();
  const minute = new Date(now).getUTCMinutes();
  // Once an hour: the :15 run is in both schedules.
  if (minute < 15 || minute >= 20) return;
  const since = written ? now - written.boundary * 1000 : Infinity;
  if (since > STALE_AFTER_MS) {
    await deps.alert(
      'TDH from the 6529 chain is late',
      written
        ? `the newest day written is ${written.cycleDay}, ${Math.floor(since / 3_600_000)} h past its boundary`
        : 'no day has been written from the chain yet'
    );
  }
}

export async function pollChainDays(deps: PollerDeps): Promise<PollOutcome> {
  if (!deps.mode) {
    logger.info('[OFF] [neither TDH chain flag is on]');
    return {};
  }
  if (deps.mode === 'CHAIN') {
    await alertIfStale(deps);
  }
  const last = await deps.latestRow();
  if (
    deps.mode === 'CHAIN' &&
    last?.mode === 'CHAIN' &&
    last.status === 'WRITTEN'
  ) {
    logger.info(`[DAY ${last.cycleDay}] [RESUMING ITS FOLLOW-UP STEPS]`);
    await runFollowUpSteps(last.cycleDay, last.stepsDone, deps.steps);
    return { resumed: last.cycleDay };
  }

  let newest: TdhChainDayInfo | null;
  try {
    newest = await deps.source.latestDay();
  } catch (e) {
    logger.warn(`[GATEWAY UNREACHABLE] [${(e as Error).message}]`);
    return {};
  }
  if (!newest) {
    logger.info('[NO APPLIED TDH DAY ON THE GATEWAY]');
    return {};
  }
  if (!isFinal(newest)) {
    logger.info(`[DAY ${newest.header.cycleDay} NOT FINAL YET]`);
    return {};
  }
  const width =
    deps.mode === 'CHAIN' && last && last.deferredKeys.length > 0
      ? await deps.keyWidth()
      : 0;
  const cycleDay = planDay(last, newest.header.cycleDay, deps.mode, width);
  if (cycleDay === null) {
    logger.info(`[UP TO DATE] [DAY ${newest.header.cycleDay}]`);
    return {};
  }
  let day: TdhChainDay | null;
  try {
    day = await readChainDay(deps.source, cycleDay);
  } catch (e) {
    logger.warn(`[DAY ${cycleDay} NOT READ] [${(e as Error).message}]`);
    return {};
  }
  if (!day) {
    logger.warn(`[DAY ${cycleDay} NOT SERVED]`);
    return {};
  }
  const result = await deps.ingest(day, deps.mode);
  logger.info(
    `[DAY ${cycleDay}] [${deps.mode}] [${result.status}] [${result.verdict ?? '-'}]`
  );
  const wasFailed = last?.cycleDay === cycleDay && last.status === 'FAILED';
  if (result.status === 'FAILED' && !wasFailed) {
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
  return { ingested: { cycleDay, result } };
}
