/**
 * Which wallets the TDH run groups together. By default the run reads the
 * site's confirmed consolidations; the chain-day ingest passes the clusters
 * of the 6529 chain's TDH day instead (`src/tdhChain/chain-cluster-source.ts`).
 */
export interface TdhClusterSource {
  /** The wallet's cluster, itself included; a wallet alone is `[wallet]`. */
  walletsOf(wallet: string): string[];
  /** Each wallet's consolidation key (its own address when alone). */
  keysFor(wallets: string[]): Record<string, string>;
  /** Every wallet in a cluster of two or more. */
  multiWalletAddresses(): { wallet: string }[];
}

/**
 * Where and with what grouping a TDH run computes. Absent fields keep
 * today's behaviour: the latest block before the run's midnight, the site's
 * consolidations, and the rows written.
 */
export interface TdhComputeOptions {
  readonly block?: { readonly number: number; readonly timestamp: Date };
  readonly clusters?: TdhClusterSource;
  /** False: compute and return the rows without writing them. */
  readonly persist?: boolean;
}
