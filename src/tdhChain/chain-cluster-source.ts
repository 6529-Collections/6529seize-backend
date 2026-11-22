import { TdhClusterSource } from '@/tdhLoop/tdh-cluster-source';
import { ChainCluster } from './chain-day-verify';

/**
 * The TDH run's grouping taken from a verified chain day: each cid's wallets
 * are one consolidation, keyed as 6529.io keys it (wallets ascending, joined
 * by `-`). A wallet without a leaf is alone.
 */
export function chainClusterSource(
  clusters: ReadonlyMap<string, ChainCluster>
): TdhClusterSource {
  const clusterOf = new Map<string, ChainCluster>();
  clusters.forEach((c) => c.wallets.forEach((w) => clusterOf.set(w, c)));
  return {
    walletsOf(wallet: string): string[] {
      const c = clusterOf.get(wallet.toLowerCase());
      return c ? c.wallets.slice() : [wallet.toLowerCase()];
    },
    keysFor(wallets: string[]): Record<string, string> {
      const keys: Record<string, string> = {};
      for (const raw of wallets) {
        const w = raw.toLowerCase();
        keys[w] = clusterOf.get(w)?.key ?? w;
      }
      return keys;
    },
    multiWalletAddresses(): { wallet: string }[] {
      const out: { wallet: string }[] = [];
      clusters.forEach((c) => {
        if (c.wallets.length > 1)
          c.wallets.forEach((w) => out.push({ wallet: w }));
      });
      return out;
    }
  };
}
