import { equalIgnoreCase } from './strings';
import {
  CONSOLIDATION_FOURTH_WALLET_ACTIVATION_TIMESTAMP,
  CONSOLIDATIONS_LIMIT,
  CONSOLIDATIONS_UNGATED_LIMIT
} from '@/constants';
import { Consolidation } from './entities/IDelegation';

export type ConsolidationLink = Pick<
  Consolidation,
  'wallet1' | 'wallet2' | 'block'
> &
  Partial<
    Pick<Consolidation, 'wallet1_registered_at' | 'wallet2_registered_at'>
  >;

export class ConsolidationTools {
  public extractConsolidationWallets(
    consolidations: ConsolidationLink[],
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

  /**
   * Groups confirmed (two-way) links into consolidations.
   *
   * The newest unused link starts a group, and a wallet joins only when it has
   * a confirmed link with every current member. Groups stop at
   * CONSOLIDATIONS_LIMIT wallets. Past CONSOLIDATIONS_UNGATED_LIMIT, a wallet
   * may only join if the resulting group has a member whose links to all other
   * members were registered in both directions at or after
   * CONSOLIDATION_FOURTH_WALLET_ACTIVATION_TIMESTAMP.
   */
  public extractConsolidations(
    consolidations: ConsolidationLink[]
  ): string[][] {
    // Newest link first. Links confirmed in the same block are ordered by
    // their pair key so every caller groups the same rows the same way.
    consolidations.sort(
      (a, b) =>
        b.block - a.block ||
        this.buildConsolidationKey([a.wallet1, a.wallet2]).localeCompare(
          this.buildConsolidationKey([b.wallet1, b.wallet2])
        )
    );

    const usedWallets = new Set<string>();
    const clusters: string[][] = [];

    // Create a quick lookup of all direct consolidations
    const linksByKey = new Map<string, ConsolidationLink>();
    for (const c of consolidations) {
      linksByKey.set(this.buildConsolidationKey([c.wallet1, c.wallet2]), c);
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

          if (newWallet && this.canJoin(cluster, newWallet, linksByKey)) {
            cluster.add(newWallet);
            queue.splice(i, 1);
            changed = true;
            break;
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

  public isPostActivationLink(link: ConsolidationLink | undefined): boolean {
    if (!link) {
      return false;
    }
    return [link.wallet1_registered_at, link.wallet2_registered_at].every(
      (registeredAt) =>
        registeredAt !== null &&
        registeredAt !== undefined &&
        Number(registeredAt) >= CONSOLIDATION_FOURTH_WALLET_ACTIVATION_TIMESTAMP
    );
  }

  private canJoin(
    cluster: Set<string>,
    wallet: string,
    linksByKey: Map<string, ConsolidationLink>
  ): boolean {
    const members = Array.from(cluster);
    const linkedToEveryMember = members.every((member) =>
      linksByKey.has(this.buildConsolidationKey([member, wallet]))
    );
    if (!linkedToEveryMember) {
      return false;
    }
    if (cluster.size < CONSOLIDATIONS_UNGATED_LIMIT) {
      return true;
    }
    return this.hasPostActivationMember([...members, wallet], linksByKey);
  }

  // The gate is checked on the whole group rather than on the wallet being
  // added, because the newest-link-first order can admit the newly registered
  // wallet before an older member.
  private hasPostActivationMember(
    wallets: string[],
    linksByKey: Map<string, ConsolidationLink>
  ): boolean {
    return wallets.some((candidate) =>
      wallets.every(
        (other) =>
          other === candidate ||
          this.isPostActivationLink(
            linksByKey.get(this.buildConsolidationKey([candidate, other]))
          )
      )
    );
  }
}

export const consolidationTools = new ConsolidationTools();
