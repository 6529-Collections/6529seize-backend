import { appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import {
  WavesSettlementSender,
  wavesSettlementSender
} from '@/waves-settlement/waves-settlement.sender';
import { DECISION_LOOP_SAFETY_MARGIN_MS } from './decision-loop-budget';

const logger = Logger.get('WAVES_SETTLEMENT_STEP');

/** The settlement sender's share of an invocation (one a minute). */
export const WAVES_SETTLEMENT_SENDER_BUDGET_MS = 20_000;

/**
 * The sender's time this invocation: its share
 * (WAVES_SETTLEMENT_SENDER_BUDGET_MS in the environment overrides it),
 * never past the safety margin; 0 when there is no time left.
 */
export function wavesSettlementBudgetMs(
  remainingMillis: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.WAVES_SETTLEMENT_SENDER_BUDGET_MS?.trim());
  const share =
    Number.isSafeInteger(raw) && raw > 0
      ? raw
      : WAVES_SETTLEMENT_SENDER_BUDGET_MS;
  if (remainingMillis === undefined) return share;
  return Math.max(
    0,
    Math.min(share, remainingMillis - DECISION_LOOP_SAFETY_MARGIN_MS)
  );
}

/**
 * Sends a SETTLEMENT_REQUEST for each decision result due on the 6529 chain
 * (FEATURE_WAVES_SETTLEMENT_SENDER), after the decision work. Best effort:
 * a gateway outage never fails the decision loop; the next run carries on.
 */
export async function sendSettlementsBestEffort(
  remainingMillis: number | undefined,
  sender: Pick<WavesSettlementSender, 'run'> = wavesSettlementSender
): Promise<void> {
  if (!appFeatures.isWavesSettlementSenderEnabled()) return;
  const budgetMs = wavesSettlementBudgetMs(remainingMillis);
  if (budgetMs === 0) return;
  try {
    const report = await sender.run({ budgetMs });
    if (report.due > 0) {
      logger.info(`[WAVES SETTLEMENT] ${JSON.stringify(report)}`);
    }
  } catch (error) {
    logger.error(`[WAVES SETTLEMENT FAILED] ${error}`);
  }
}
