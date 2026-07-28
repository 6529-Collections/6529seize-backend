import { retrieveConsolidationsForWallets } from '@/db';
import { ConsolidationEvent } from '@/entities/IDelegation';
import { ConsolidatedTDH } from '@/entities/ITDH';

const CONSOLIDATION_QUERY_BATCH_SIZE = 100;

function getWallets(consolidation: ConsolidatedTDH): string[] {
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
    const wallets = getWallets(consolidation).map((wallet) =>
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
