import { MAX_BATCHES, MAX_SOURCE_ROWS } from './types';
import {
  walletTransferAnalysisService,
  WalletTransferAnalysisService
} from './wallet-transfer-analysis.service';

/**
 * Runs the analysis's own `update` until it has summarised every bucket of
 * Memes transfers in `transactions`. From an empty state (no row in
 * wallet_transfer_analysis_states) that is every transfer there is; with a
 * stored state it is every bucket after it. Returns the buckets processed.
 */
export async function updateUntilCaughtUp(
  service: Pick<WalletTransferAnalysisService, 'update'>
): Promise<number> {
  let buckets = 0;
  for (;;) {
    const result = await service.update({
      maxBatches: MAX_BATCHES,
      maxRows: MAX_SOURCE_ROWS
    });
    // The first entry of each call can re-summarise the last bucket already
    // done; only the buckets it moved forward count.
    const forward = result.refreshed_buckets.filter(
      (bucket) => !bucket.reconciled
    ).length;
    buckets += forward;
    if (forward < MAX_BATCHES) return buckets;
  }
}

/**
 * The rebuild check's step for wallet_transfer_pair_days and
 * wallet_transfer_wallet_days: the analysis from empty, over the rebuilt
 * transactions.
 */
export async function rebuildWalletTransferAnalysis(): Promise<void> {
  await updateUntilCaughtUp(walletTransferAnalysisService);
}
