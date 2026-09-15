import { retrieveConsolidationsForWallets } from '@/db';
import { ConsolidationEvent } from '@/entities/IDelegation';
import { ConsolidatedTDH } from '@/entities/ITDH';
import { getConsolidationWallets } from '@/tdhLoop/consolidation-wallets';

const CONSOLIDATION_QUERY_BATCH_SIZE = 100;

export async function getAffectedWallets(
  events: ConsolidationEvent[],
  currentConsolidations: ConsolidatedTDH[]
): Promise<Set<string>> {
  const directlyAffectedWallets = new Set<string>();
  for (const event of events) {
    directlyAffectedWallets.add(event.wallet1.toLowerCase());
    directlyAffectedWallets.add(event.wallet2.toLowerCase());
  }

  const affectedWallets = new Set(directlyAffectedWallets);
  for (const consolidation of currentConsolidations) {
    const wallets = getConsolidationWallets(consolidation).map((wallet) =>
      wallet.toLowerCase()
    );
    if (wallets.some((wallet) => directlyAffectedWallets.has(wallet))) {
      wallets.forEach((wallet) => affectedWallets.add(wallet));
    }
  }

  // retrieveConsolidationsForWallets resolves each seed through the recursive
  // confirmed graph and returns the complete cluster key. Members discovered
  // from those keys therefore do not require another graph lookup.
  const clusterSeeds = Array.from(affectedWallets);
  for (
    let offset = 0;
    offset < clusterSeeds.length;
    offset += CONSOLIDATION_QUERY_BATCH_SIZE
  ) {
    const batch = clusterSeeds.slice(
      offset,
      offset + CONSOLIDATION_QUERY_BATCH_SIZE
    );
    const currentClusterKeys = await retrieveConsolidationsForWallets(batch);
    Object.values(currentClusterKeys).forEach((consolidationKey) => {
      consolidationKey
        .split('-')
        .filter(Boolean)
        .forEach((wallet) => affectedWallets.add(wallet.toLowerCase()));
    });
  }

  return affectedWallets;
}
