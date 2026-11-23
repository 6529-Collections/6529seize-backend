import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { whileRebuildingEthereumIndexes } from '@/holdings/rebuild-mode';
import { findNextGenTransactions } from './nextgen';
import { getNextgenNetwork } from './nextgen_constants';

/**
 * The rebuild check's step for the NextGen tables (collections, logs,
 * tokens, traits and scores, and the NextGen rows of `transactions`): the
 * NextGen contract loop's own runs, from its start block, in rebuild mode,
 * until one reaches the run's Ethereum mark (else the finalized block).
 *
 * The collections, logs, owners and mint data come from the chain. Token
 * names, images and traits, and so the trait scores, come from each
 * token's metadata at the collection's base URI.
 */
export async function rebuildNextGen(ctx: {
  readonly mark: { readonly ethBlock: number | null };
}): Promise<void> {
  const toBlock =
    ctx.mark.ethBlock ??
    (await getEthereumRpcClient(getNextgenNetwork()).getBlock('finalized'))
      .number;
  await whileRebuildingEthereumIndexes(async () => {
    for (;;) {
      const { caughtUp } = await findNextGenTransactions(undefined, {
        toBlock
      });
      if (caughtUp) return;
    }
  });
}
