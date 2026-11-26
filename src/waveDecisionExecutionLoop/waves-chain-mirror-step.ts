import { appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import {
  WavesChainMirror,
  wavesChainMirror
} from '@/waves-chain-mirror/waves-chain-mirror.service';
import { DECISION_LOOP_SAFETY_MARGIN_MS } from './decision-loop-budget';

const logger = Logger.get('WAVES_CHAIN_MIRROR_STEP');

/** The mirror's share of an invocation (one a minute), after the index's. */
export const WAVES_CHAIN_MIRROR_BUDGET_MS = 25_000;

/**
 * The mirror's time this invocation: WAVES_CHAIN_MIRROR_BUDGET_MS or its
 * default, never past the safety margin; 0 when there is no time left.
 */
export function wavesChainMirrorBudgetMs(
  remainingMillis: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.WAVES_CHAIN_MIRROR_BUDGET_MS?.trim());
  const share =
    Number.isSafeInteger(raw) && raw > 0 ? raw : WAVES_CHAIN_MIRROR_BUDGET_MS;
  if (remainingMillis === undefined) return share;
  return Math.max(
    0,
    Math.min(share, remainingMillis - DECISION_LOOP_SAFETY_MARGIN_MS)
  );
}

/**
 * Copies the chain's decisions into 6529.io's competition tables
 * (FEATURE_WAVES_CHAIN_MIRROR), after the chain index. Best effort: an
 * error never fails the decision loop; the next run carries on.
 */
export async function mirrorChainWavesBestEffort(
  remainingMillis: number | undefined,
  mirror: Pick<WavesChainMirror, 'run'> = wavesChainMirror
): Promise<void> {
  if (!appFeatures.isWavesChainMirrorEnabled()) return;
  const budgetMs = wavesChainMirrorBudgetMs(remainingMillis);
  if (budgetMs === 0) return;
  try {
    const report = await mirror.run({ budgetMs });
    logger.info(`[WAVES CHAIN MIRROR] ${JSON.stringify(report)}`);
  } catch (error) {
    logger.error(`[WAVES CHAIN MIRROR FAILED] ${error}`);
  }
}
