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

    // Create a quick lookup of all direct consolidations
    const linksByKey = new Map<string, ConsolidationLink>();
    for (const c of consolidations) {
      linksByKey.set(this.buildConsolidationKey([c.wallet1, c.wallet2]), c);
    }

    const usedWallets = new Set<string>();
    const clusters: string[][] = [];
    const queue = [...consolidations];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (
        usedWallets.has(current.wallet1) ||
        usedWallets.has(current.wallet2)
      ) {
        continue;
      }
      const cluster = this.growCluster(current, queue, usedWallets, linksByKey);
      for (const w of cluster) {
        usedWallets.add(w);
      }
      clusters.push(cluster);
    }

    // Any wallets left out entirely are added as singletons.
    for (const c of consolidations) {
      for (const w of [c.wallet1, c.wallet2]) {
        if (!usedWallets.has(w)) {
          clusters.push([w]);
          usedWallets.add(w);
        }
      }
    }

    return clusters;
  }

  /**
   * Starts a cluster from a link and keeps adding the wallet of the first
   * queued link that can join, until none can or the limit is reached. Links
   * that add a wallet are removed from the queue.
   */
  private growCluster(
    seed: ConsolidationLink,
    queue: ConsolidationLink[],
    usedWallets: Set<string>,
    linksByKey: Map<string, ConsolidationLink>
  ): string[] {
    const cluster = new Set<string>([seed.wallet1, seed.wallet2]);
    while (cluster.size < CONSOLIDATIONS_LIMIT) {
      const index = queue.findIndex((candidate) => {
        const newWallet = this.getJoiningWallet(
          cluster,
          candidate,
          usedWallets
        );
        return !!newWallet && this.canJoin(cluster, newWallet, linksByKey);
      });
      if (index === -1) {
        break;
      }
      cluster.add(this.getJoiningWallet(cluster, queue[index], usedWallets)!);
      queue.splice(index, 1);
    }
    return Array.from(cluster);
  }

  /** The wallet a link would add to the cluster, if it adds an unused one. */
  private getJoiningWallet(
    cluster: Set<string>,
    link: ConsolidationLink,
    usedWallets: Set<string>
  ): string | null {
    const { wallet1, wallet2 } = link;
    if (
      cluster.has(wallet1) &&
      !cluster.has(wallet2) &&
      !usedWallets.has(wallet2)
    ) {
      return wallet2;
    }
    if (
      cluster.has(wallet2) &&
      !cluster.has(wallet1) &&
      !usedWallets.has(wallet1)
    ) {
      return wallet1;
    }
    return null;
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
