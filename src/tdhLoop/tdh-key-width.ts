import { Logger } from '@/logging';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { splitByKeyWidth, tdhChainDaysDb } from '@/tdhChain/tdh-chain-days.db';

const logger = Logger.get('TDH_KEY_WIDTH');

/** The `consolidation_key` width before the widening migration. */
const WIDTH_BEFORE_MIGRATION = 200;

/**
 * The rows whose consolidation key fits the TDH tables' columns. From
 * Wednesday a chain identity can hold up to 16 wallets (687 characters)
 * while the columns hold 200 until the widening migration is deployed. A
 * consolidation that doesn't fit is left out of the whole write, logged and
 * alerted; the next run writes it once the columns are wide enough. Never a
 * crash and never a half-written identity (coordinator's ruling, 22 Nov).
 */
export async function keepConsolidationKeysThatFit<
  T extends { consolidation_key: string }
>(
  rows: T[],
  readWidth: () => Promise<number> = () =>
    tdhChainDaysDb.consolidationKeyWidth()
): Promise<T[]> {
  let width = WIDTH_BEFORE_MIGRATION;
  try {
    width = await readWidth();
  } catch (e) {
    logger.warn(
      `[COULD NOT READ THE KEY WIDTH] [USING ${width}] [${(e as Error).message}]`
    );
  }
  const { fit, deferred } = splitByKeyWidth(rows, width);
  if (deferred.length > 0) {
    logger.error(
      `[KEY WIDTH ${width}] [${deferred.length} CONSOLIDATIONS LEFT OUT UNTIL THE COLUMNS ARE WIDER]`
    );
    await priorityAlertsContext.sendPriorityAlertIfConfigured(
      'TDH consolidation keys too wide',
      new Error(
        `${deferred.length} consolidations left out of this TDH write: their keys are longer than ${width} characters`
      )
    );
  }
  return fit;
}
