import { appFeatures } from '@/app-features';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';

const logger = Logger.get('HOLDINGS_MEMBERSHIP_CHANGE');

/**
 * The part of the identity mirror's membership change that holdings reads:
 * the chain height it applied, and every wallet whose consolidation key
 * changed together with the other wallets of the rows it left and joined.
 */
export interface HoldingsMembershipChange {
  readonly height: number;
  readonly wallets: readonly string[];
}

/**
 * The identity mirror calls this in the transaction that writes
 * address_consolidation_keys, so the request commits or rolls back with the
 * new keys. With FEATURE_HOLDINGS_MEMBERSHIP_QUEUE on, it queues the wallets
 * for nftOwnersLoop and aggregatedActivityLoop; nftOwnersLoop passes them on
 * to ownersBalancesLoop. Each loop groups them again from
 * address_consolidation_keys. With the flag off it only logs, and the
 * delegations loop's own re-key does the work.
 */
export async function holdingsMembershipChanged(
  change: HoldingsMembershipChange,
  ctx: RequestContext
): Promise<void> {
  if (!ctx.connection) {
    throw new Error(
      'holdingsMembershipChanged needs the transaction that writes the keys'
    );
  }
  const wallets = Array.from(
    new Set(change.wallets.map((wallet) => wallet.toLowerCase()))
  );
  if (!wallets.length) return;
  if (!appFeatures.isHoldingsMembershipQueueEnabled()) {
    logger.info(
      `[MEMBERSHIP CHANGE NOT QUEUED: FLAG OFF] [HEIGHT ${change.height}] [WALLETS ${wallets.length}]`
    );
    return;
  }
  await transferReconciliationDb.enqueue(wallets, ['owners', 'activity'], ctx);
  logger.info(
    `[MEMBERSHIP CHANGE QUEUED] [HEIGHT ${change.height}] [WALLETS ${wallets.length}]`
  );
}
