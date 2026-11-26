import { appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import {
  WavesChainIndex,
  wavesChainIndex
} from '@/waves-chain-index/waves-chain-index.service';
import { DECISION_LOOP_SAFETY_MARGIN_MS } from './decision-loop-budget';

const logger = Logger.get('WAVES_CHAIN_INDEX_STEP');

/** The index's share of an invocation (one a minute). */
export const WAVES_CHAIN_INDEX_BUDGET_MS = 40_000;

/**
 * The index's time this invocation: its share, never past the safety margin;
 * 0 when there is no time left.
 */
export function wavesChainIndexBudgetMs(
  remainingMillis: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.WAVES_CHAIN_INDEX_BUDGET_MS?.trim());
  const share =
    Number.isSafeInteger(raw) && raw > 0 ? raw : WAVES_CHAIN_INDEX_BUDGET_MS;
  if (remainingMillis === undefined) return share;
  return Math.max(
    0,
    Math.min(share, remainingMillis - DECISION_LOOP_SAFETY_MARGIN_MS)
  );
}

/**
 * Keeps 6529.io's index of the chain's waves (FEATURE_WAVES_CHAIN_INDEX),
 * after the decision work. Best effort: a gateway outage never fails the
 * decision loop; the index saves its error and the next run carries on.
 */
export async function indexChainWavesBestEffort(
  remainingMillis: number | undefined,
  index: Pick<WavesChainIndex, 'run'> = wavesChainIndex
): Promise<void> {
  if (!appFeatures.isWavesChainIndexEnabled()) return;
  const budgetMs = wavesChainIndexBudgetMs(remainingMillis);
  if (budgetMs === 0) return;
  try {
    const report = await index.run({ budgetMs });
    logger.info(`[WAVES CHAIN INDEX] ${JSON.stringify(report)}`);
  } catch (error) {
    logger.error(`[WAVES CHAIN INDEX FAILED] ${error}`);
  }
}
