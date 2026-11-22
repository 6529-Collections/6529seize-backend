import { updateAggregatedActivity } from '@/aggregatedActivityLoop/aggregated_activity';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { updateNftOwners } from '@/nftOwnersLoop/nft_owners';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from '@/nftsLoop/nft-extended-data';
import { NFT_MODE, processNFTs } from '@/nftsLoop/nfts';
import { updateOwnerBalances } from '@/ownersBalancesLoop/owners_balances';
import { transactionsDiscoveryService } from '@/transactions/transactions-discovery.service';
import { whileRebuildingEthereumIndexes } from './rebuild-mode';

/**
 * The rebuild check's steps for the transactions, the NFT catalogue and the
 * holdings tables, in this order. Each fills its tables from empty with the
 * live loops' own code, in rebuild mode, up to the run's Ethereum mark.
 *
 * NextGen's transactions, tokens and history are not here yet.
 */
export interface EthereumRebuildContext {
  readonly mark: { readonly ethBlock: number | null };
}

async function markBlock(ctx: EthereumRebuildContext): Promise<number> {
  return (
    ctx.mark.ethBlock ??
    (await getEthereumRpcClient().getBlock('finalized')).number
  );
}

/** 1. Transactions of the Memes, Gradients and Meme Lab contracts. */
export async function rebuildTransactions(
  ctx: EthereumRebuildContext
): Promise<void> {
  const toBlock = await markBlock(ctx);
  await whileRebuildingEthereumIndexes(async () => {
    for (const contract of [
      MEMES_CONTRACT,
      GRADIENT_CONTRACT,
      MEMELAB_CONTRACT
    ]) {
      await transactionsDiscoveryService.getAndSaveTransactionsForContract(
        contract,
        null,
        toBlock
      );
    }
  });
}

/** 2. NFT owners by wallet and by consolidation, from the transactions. */
export async function rebuildNftOwners(): Promise<void> {
  await whileRebuildingEthereumIndexes(() => updateNftOwners(true));
}

/**
 * 3. The NFT catalogue from token metadata (supply from the owners), then the
 * extended data and the Memes seasons.
 */
export async function rebuildNftCatalogue(): Promise<void> {
  await whileRebuildingEthereumIndexes(async () => {
    await processNFTs(NFT_MODE.DISCOVER);
    await processNFTs(NFT_MODE.REFRESH);
    await findMemesExtendedData();
    await findMemeLabExtendedData();
  });
}

/** 4. Activity and balances by wallet and by consolidation (need the seasons). */
export async function rebuildHoldingsBalances(): Promise<void> {
  await whileRebuildingEthereumIndexes(async () => {
    await updateAggregatedActivity(true);
    await updateOwnerBalances(true);
  });
}
