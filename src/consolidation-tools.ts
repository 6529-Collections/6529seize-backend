import { equalIgnoreCase } from './strings';
import { CONSOLIDATIONS_LIMIT } from '@/constants';
import { Consolidation } from './entities/IDelegation';

export class ConsolidationTools {
  public extractConsolidationWallets(
    consolidations: any[],
    wallet: string
  ): string[] {
    const clusters = this.extractConsolidations(consolidations);
    const walletCluster = clusters.find((c) =>
      c.some((w) => equalIgnoreCase(w, wallet))
    );
    if (walletCluster) {
      return walletCluster;
    }
    return [wallet];
  }

  public extractConsolidations(consolidations: Consolidation[]): string[][] {
    // Sort by block descending
    consolidations.sort((a, b) => b.block - a.block);

    const usedWallets = new Set<string>();
    const clusters: string[][] = [];

    // Create a quick lookup of all direct consolidations
    const consolidationSet = new Set<string>();
    for (const c of consolidations) {
      consolidationSet.add(this.buildConsolidationKey([c.wallet1, c.wallet2]));
    }

    // Convert consolidations into a queue
    const queue = [...consolidations];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const { wallet1, wallet2 } = current;

      if (usedWallets.has(wallet1) || usedWallets.has(wallet2)) {
        continue;
      }

      const cluster = new Set<string>();
      cluster.add(wallet1);
      cluster.add(wallet2);

      let changed = true;

      // Keep trying to expand this cluster
      while (changed && cluster.size < CONSOLIDATIONS_LIMIT) {
        changed = false;

        for (let i = 0; i < queue.length; i++) {
          const candidate = queue[i];
          const { wallet1: w1, wallet2: w2 } = candidate;

          let newWallet: string | null = null;

          if (cluster.has(w1) && !cluster.has(w2) && !usedWallets.has(w2)) {
            newWallet = w2;
          } else if (
            cluster.has(w2) &&
            !cluster.has(w1) &&
            !usedWallets.has(w1)
          ) {
            newWallet = w1;
          }

          if (newWallet) {
            const safeWallet = newWallet;
            const allConnectionsExist = Array.from(cluster).every((existing) =>
              consolidationSet.has(
                this.buildConsolidationKey([existing, safeWallet])
              )
            );

            if (allConnectionsExist) {
              cluster.add(safeWallet);
              queue.splice(i, 1);
              changed = true;
              break;
            }
          }
        }
      }

      // finalize cluster
      const clusterArray = Array.from(cluster);
      for (const w of clusterArray) {
        usedWallets.add(w);
      }
      clusters.push(clusterArray);
    }

    // Any wallets left out entirely? Add them as singletons.
    const allWallets = new Set<string>();
    for (const c of consolidations) {
      allWallets.add(c.wallet1);
      allWallets.add(c.wallet2);
    }

    for (const w of Array.from(allWallets)) {
      if (!usedWallets.has(w)) {
        clusters.push([w]);
        usedWallets.add(w);
      }
    }

    return clusters;
  }

  public buildConsolidationKey(wallets: string[]): string {
    const sortedWallets = wallets
      .map((it) => it.toLowerCase())
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .filter((it) => it !== '');
    return sortedWallets.join('-');
  }
}

export const consolidationTools = new ConsolidationTools();
