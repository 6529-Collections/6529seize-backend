import { consolidateActivity } from '@/aggregatedActivityLoop/aggregated_activity';
import { appFeatures } from '@/app-features';
import { consolidateNftOwners } from '@/nftOwnersLoop/nft_owners';
import { consolidateOwnerBalances } from '@/ownersBalancesLoop/owners_balances';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';

/**
 * Regroups the consolidated holdings of wallets whose consolidation changed.
 * With FEATURE_HOLDINGS_MEMBERSHIP_QUEUE on it queues them for the holdings
 * loops, which regroup them on their next runs, as they do for a membership
 * change from the chain. With it off it regroups them now, as before.
 * `committedStage` is called after each stage that commits.
 */
export async function regroupHoldings(
  wallets: Set<string>,
  committedStage: () => void
): Promise<void> {
  if (!wallets.size) return;
  if (appFeatures.isHoldingsMembershipQueueEnabled()) {
    await transferReconciliationDb.enqueueRepair(Array.from(wallets));
    committedStage();
    return;
  }
  await consolidateNftOwners(wallets);
  committedStage();
  await consolidateOwnerBalances(wallets);
  committedStage();
  await consolidateActivity(wallets);
  committedStage();
}
