import { ConsolidatedTDH } from '@/entities/ITDH';

export function getConsolidationWallets(
  consolidation: Pick<ConsolidatedTDH, 'consolidation_key' | 'wallets'>
): string[] {
  if (Array.isArray(consolidation.wallets)) {
    return consolidation.wallets;
  }
  if (typeof consolidation.wallets === 'string') {
    try {
      const parsedWallets: unknown = JSON.parse(consolidation.wallets);
      if (
        Array.isArray(parsedWallets) &&
        parsedWallets.every((wallet) => typeof wallet === 'string')
      ) {
        return parsedWallets;
      }
    } catch {
      // Fall through to the canonical key if the stored JSON is malformed.
    }
  }
  return consolidation.consolidation_key.split('-');
}
