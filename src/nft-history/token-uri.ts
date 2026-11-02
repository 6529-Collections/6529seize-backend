import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { claimEventId, ClaimEvent } from './claim-events';
import { nftHistoryDb } from './history.db';
import { prepareHistoryWrite } from './processor';

export async function ingestTokenUriUpdate(
  hash: string,
  contract: string,
  tokenId: number,
  uri: string
): Promise<void> {
  const rpc = getEthereumRpcClient();
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(hash),
    rpc.getTransactionReceipt(hash)
  ]);
  if (
    !tx ||
    receipt?.status !== 1 ||
    tx.to?.toLowerCase() !== contract.toLowerCase()
  )
    throw new Error(`Token URI transaction unavailable or failed: ${hash}`);
  const parsed = NFT_HISTORY_IFACE.parseTransaction({ data: tx.data });
  if (
    parsed?.name !== 'setTokenURI' ||
    String(parsed.args.tokenId) !== String(tokenId) ||
    parsed.args.uri_ !== uri
  )
    throw new Error('Token URI calldata mismatch');
  const block = await rpc.getBlock(receipt.blockNumber);
  if (
    block.hash !== receipt.blockHash ||
    tx.blockHash !== receipt.blockHash ||
    tx.index !== receipt.index
  )
    throw new Error('Token URI block/position changed');
  // Manifold setTokenURI emits no URI log. Reserve -1 for its single verified
  // top-level calldata operation; real claim log indexes are non-negative.
  const event: ClaimEvent = {
    event_id: claimEventId({ transactionHash: hash, logIndex: -1 }),
    contract,
    nft_id: tokenId,
    uri,
    block: receipt.blockNumber,
    block_hash: receipt.blockHash,
    transaction_hash: hash,
    transaction_index: receipt.index,
    log_index: -1,
    transaction_date: new Date(block.timestamp * 1000),
    extension: contract.toLowerCase(),
    claim_id: null
  };
  const plan = await prepareHistoryWrite(
    event,
    await nftHistoryDb.snapshot(contract, tokenId)
  );
  if (plan.inserts.length) await nftHistoryDb.apply(plan);
}
