let rebuilding = false;

/**
 * True while a rebuild of the Ethereum indexes runs (the transactions, the
 * NFT catalogue and the holdings tables). The loops then have no effect
 * outside those tables: no "is Live!" announcement, no media upload job, no
 * ENS lookup, and no write to the artists, mint stats or subscription tables,
 * which rebuild on their own.
 */
export function isRebuildingEthereumIndexes(): boolean {
  return rebuilding;
}

/** Runs `work` in rebuild mode, and always leaves it. */
export async function whileRebuildingEthereumIndexes<T>(
  work: () => Promise<T>
): Promise<T> {
  rebuilding = true;
  try {
    return await work();
  } finally {
    rebuilding = false;
  }
}
