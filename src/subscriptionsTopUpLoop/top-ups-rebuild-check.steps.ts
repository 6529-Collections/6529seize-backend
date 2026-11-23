import { Logger } from '@/logging';
import { recordTopUps } from './db.subscriptions_topup';
import { discoverTopUps } from './subscription_topups';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UPS_REBUILD_CHECK');

/** What the rebuild check's runner passes a step (src/rebuild/manifest.types.ts). */
interface CheckStepContext {
  readonly sources: { readonly ethereum: string | null };
  readonly mark: { readonly ethBlock: number | null };
}

/**
 * The rebuild check's rebuilder for subscriptions_top_up: the top-up
 * loop's own discovery from genesis up to the run's mark, writing the top-up
 * rows alone (recordTopUps). The loop's cursor is not moved, and nothing
 * is credited again: after the switch the identity tables hold the credit,
 * and the copy-back rebuilds the legacy balances from them.
 */
export async function rebuildTopUpsInCheck(
  ctx: CheckStepContext
): Promise<void> {
  if (!ctx.sources.ethereum) {
    throw new Error(
      'The top-up rebuild reads Ethereum: the run has no ethereum source'
    );
  }
  await discoverTopUps(true, {
    persist: recordTopUps,
    checkpoint: false,
    toBlock: ctx.mark.ethBlock ?? undefined
  });
  logger.info(
    `[TOP_UPS_REBUILD_CHECK] [to ${ctx.mark.ethBlock ?? 'the confirmed head'}]`
  );
}
