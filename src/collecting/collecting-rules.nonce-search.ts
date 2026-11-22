import type { JsonRpcProvider } from 'ethers';
import type { NonceTransaction } from './collecting-rules.chain-check';

/**
 * The mined transaction that used `wallet`'s `nonce`, up to the safe block,
 * or null while that nonce is unused there. A wallet's nonce count only
 * grows, so the first block where it passes `nonce` is found by halving,
 * and that block holds the transaction. Reads historical state.
 */
export async function nonceTransactionOnChain(
  rpc: Pick<
    JsonRpcProvider,
    'getBlock' | 'getTransactionCount' | 'getTransactionReceipt'
  >,
  wallet: string,
  nonce: number
): Promise<NonceTransaction | null> {
  const safe = await rpc.getBlock('safe');
  if (!safe || (await rpc.getTransactionCount(wallet, safe.number)) <= nonce)
    return null;
  let low = 0;
  let high = safe.number;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await rpc.getTransactionCount(wallet, middle)) > nonce) high = middle;
    else low = middle + 1;
  }
  const block = await rpc.getBlock(low, true);
  const found = block?.prefetchedTransactions.find(
    (transaction) =>
      transaction.from.toLowerCase() === wallet.toLowerCase() &&
      transaction.nonce === nonce
  );
  if (!found) return null;
  const receipt = await rpc.getTransactionReceipt(found.hash);
  if (!receipt) return null;
  return {
    hash: found.hash.toLowerCase(),
    transaction: {
      from: found.from,
      to: found.to,
      value: found.value,
      nonce: found.nonce
    },
    receipt: {
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data
      }))
    }
  };
}
