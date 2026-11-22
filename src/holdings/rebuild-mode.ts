import { AsyncLocalStorage } from 'node:async_hooks';

const rebuildMode = new AsyncLocalStorage<true>();

/**
 * True while a rebuild of the Ethereum indexes runs (the transactions, the
 * NFT catalogue with its artists, NFT history and the holdings tables). The
 * loops then have no effect outside those tables: no "is Live!"
 * announcement, no media upload job, no ENS lookup, and no write to the mint
 * stats or subscription tables, which rebuild on their own.
 */
export function isRebuildingEthereumIndexes(): boolean {
  return rebuildMode.getStore() === true;
}

/**
 * Runs `work` in rebuild mode. The mode follows `work` and the calls it
 * awaits, and nothing else: a loop running beside it in the same process
 * stays outside, a nested rebuild stays inside until the outer one ends, and
 * the mode ends with `work`, also when it fails.
 */
export function whileRebuildingEthereumIndexes<T>(
  work: () => Promise<T>
): Promise<T> {
  return rebuildMode.run(true, work);
}
