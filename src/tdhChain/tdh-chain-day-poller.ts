import { Logger } from '@/logging';
import { ChainTdhIngestResult } from './chain-tdh-ingest';
import { TdhChainDayMode, TdhChainDayRow } from './tdh-chain-days.db';
import { readChainDay, TdhChainSource } from './tdh-chain-source';
import { TdhChainDay } from './tdh-chain.types';

/**
 * "The chain applied day N": the replacement for the 00:01 start. Every few
 * minutes the poller reads the newest final TDH day from the gateway and
 * ingests the days the site hasn't taken yet, oldest first. The end signal
 * stays "TDH calculations done", sent after the identities sync that the
 * CHAIN write starts, as for a full tdhLoop run.
 */

const logger = Logger.get('TDH_CHAIN_DAY_POLLER');

/**
 * Days ingested at most per run. Each is a full TDH computation, about as
 * long as a tdhLoop run, so one a run keeps inside the Lambda limit; a
 * backlog clears one day every five minutes.
 */
export const MAX_DAYS_PER_RUN = 1;

export interface PollerDeps {
  readonly mode: TdhChainDayMode | null;
  readonly source: TdhChainSource;
  latestRow(): Promise<TdhChainDayRow | null>;
  keyWidth(): Promise<number>;
  ingest(
    day: TdhChainDay,
    mode: TdhChainDayMode
  ): Promise<ChainTdhIngestResult>;
  alert(title: string, message: string): Promise<void>;
}

/**
 * Which days to ingest, oldest first:
 * - nothing ingested yet: the newest day only (no backfill);
 * - the last day FAILED: that day again;
 * - the last day KEYS_DEFERRED in CHAIN mode: that day again once every
 *   deferred key fits the columns;
 * - CHAIN mode after SHADOW: the newest shadowed day again, so the switch
 *   writes the day the site shows;
 * - then each day after the last, up to the newest.
 */
export function planDays(
  last: TdhChainDayRow | null,
  newest: number,
  mode: TdhChainDayMode,
  keyWidth: number
): number[] {
  if (!last) return [newest];
  const days: number[] = [];
  const redo =
    last.status === 'FAILED' ||
    (mode === 'CHAIN' &&
      last.status === 'KEYS_DEFERRED' &&
      last.deferredKeys.every((k) => k.length <= keyWidth)) ||
    (mode === 'CHAIN' && last.mode === 'SHADOW');
  if (redo && last.cycleDay <= newest) days.push(last.cycleDay);
  for (let d = last.cycleDay + 1; d <= newest; d++) days.push(d);
  return days.slice(0, MAX_DAYS_PER_RUN);
}

export interface PollOutcome {
  readonly ingested: { cycleDay: number; result: ChainTdhIngestResult }[];
}

export async function pollChainDays(deps: PollerDeps): Promise<PollOutcome> {
  const outcome: PollOutcome = { ingested: [] };
  if (!deps.mode) {
    logger.info('[OFF] [neither TDH chain flag is on]');
    return outcome;
  }
  let newest;
  try {
    newest = await deps.source.latestDay();
  } catch (e) {
    // The next run asks again; the chain side raises its own late-day alert.
    logger.warn(`[GATEWAY UNREACHABLE] [${(e as Error).message}]`);
    return outcome;
  }
  if (!newest) {
    logger.info('[NO APPLIED TDH DAY ON THE GATEWAY]');
    return outcome;
  }
  const last = await deps.latestRow();
  const width =
    deps.mode === 'CHAIN' && last?.status === 'KEYS_DEFERRED'
      ? await deps.keyWidth()
      : 0;
  const plan = planDays(last, newest.header.cycleDay, deps.mode, width);
  if (plan.length === 0) {
    logger.info(`[UP TO DATE] [DAY ${newest.header.cycleDay}]`);
    return outcome;
  }
  for (const cycleDay of plan) {
    const day = await readChainDay(deps.source, cycleDay);
    if (!day) {
      logger.warn(`[DAY ${cycleDay} NOT SERVED] [STOPPING]`);
      break;
    }
    const result = await deps.ingest(day, deps.mode);
    outcome.ingested.push({ cycleDay, result });
    logger.info(
      `[DAY ${cycleDay}] [${deps.mode}] [${result.status}] [${result.verdict ?? '-'}]`
    );
    const wasFailed = last?.cycleDay === cycleDay && last.status === 'FAILED';
    if (result.status === 'FAILED') {
      if (!wasFailed) {
        await deps.alert(
          `TDH day ${cycleDay} from the 6529 chain failed its checks`,
          JSON.stringify(result.summary.failures.slice(0, 5))
        );
      }
      break;
    }
    if (result.verdict === 'MISMATCH') {
      await deps.alert(
        `TDH day ${cycleDay}: the site and the 6529 chain differ (${deps.mode})`,
        JSON.stringify({
          cache: result.summary.cache?.counts,
          live: result.summary.live?.counts
        })
      );
    }
    if (result.status === 'KEYS_DEFERRED') {
      await deps.alert(
        `TDH day ${cycleDay}: ${result.deferredKeys.length} consolidations wait for wider key columns`,
        `${result.deferredKeys.length} keys longer than the consolidation_key columns`
      );
    }
  }
  return outcome;
}
