import { Interface } from 'ethers';
import { NULL_ADDRESS, SUBSCRIPTIONS_ADDRESS } from '@/constants';
import { getAlchemyInstance } from '@/alchemy';
import { SubscriptionTopUp } from '@/entities/ISubscription';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { getAllSubscriptionTopUps } from '@/subscriptionsTopUpLoop/alchemy.subscriptions';
import { getSubscriptionsNetwork } from '@/subscriptionsTopUpLoop/subscription_topups';
import type { EthereumFacts } from './journal-verify';

const TRANSFERS = new Interface([
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

interface TransactionLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** The Ethereum reads the verifier needs, as functions (production or a test's). */
export interface EthereumReads {
  /** The block a transaction is in, or null if there is no such mined transaction. */
  blockOf(hash: string): Promise<number | null>;
  /** The subscription top-ups in one block, as the top-up loop reads them. */
  topUpsIn(block: number): Promise<SubscriptionTopUp[]>;
  /** A mined transaction's logs, or null if there is no such transaction. */
  logsOf(hash: string): Promise<readonly TransactionLog[] | null>;
}

/** A log as an ERC-1155 transfer, or null if it is none. */
function transferOf(log: TransactionLog) {
  try {
    return TRANSFERS.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
}

/** Tokens of one ERC-1155 id minted from the null address to `to` in these logs. */
function mintedIn(
  logs: readonly TransactionLog[],
  contract: string,
  tokenId: number,
  to: string
): number {
  let minted = BigInt(0);
  const id = BigInt(tokenId);
  for (const log of logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) {
      continue;
    }
    const parsed = transferOf(log);
    // Both events are (operator, from, to, id or ids, value or values); read
    // by position, since a Result's `values` is the array method.
    const args = parsed?.args;
    if (
      !parsed ||
      !args ||
      String(args[1]).toLowerCase() !== NULL_ADDRESS ||
      String(args[2]).toLowerCase() !== to.toLowerCase()
    ) {
      continue;
    }
    const ids: unknown[] =
      parsed.name === 'TransferSingle' ? [args[3]] : Array.from(args[3]);
    const values: unknown[] =
      parsed.name === 'TransferSingle' ? [args[4]] : Array.from(args[4]);
    ids.forEach((each, i) => {
      if (BigInt(String(each)) === id) {
        minted += BigInt(String(values[i]));
      }
    });
  }
  return Number(minted);
}

/**
 * The verifier's Ethereum port over these reads. A top-up is the transfer
 * the top-up loop itself would find for that hash (Alchemy's transfers to
 * the subscriptions address in the transaction's block, external and
 * internal), so its value is the same double the loop recorded.
 */
export function ethereumFactsOf(reads: EthereumReads): EthereumFacts {
  return {
    async topUp(hash) {
      const block = await reads.blockOf(hash);
      if (block === null) {
        return null;
      }
      const transfer = (await reads.topUpsIn(block)).find(
        (t) => t.hash.toLowerCase() === hash.toLowerCase()
      );
      return transfer
        ? {
            from: transfer.from_wallet,
            to: SUBSCRIPTIONS_ADDRESS,
            valueEth: Number(transfer.amount),
            block: Number(transfer.block)
          }
        : null;
    },
    async mintedTo(hash, contract, tokenId, to) {
      const logs = await reads.logsOf(hash);
      return logs ? mintedIn(logs, contract, tokenId, to) : 0;
    }
  };
}

/**
 * The backend's own Ethereum access with its existing config: top-ups on
 * the top-up loop's network (SUBSCRIPTIONS_CHAIN_ID) through Alchemy, as
 * the loop reads them, and mints on mainnet through the RPC client, where
 * the transactions loop finds the airdrops.
 */
export function backendEthereumFacts(): EthereumFacts {
  const network = getSubscriptionsNetwork();
  const topUpRpc = getEthereumRpcClient(network);
  const mintRpc = getEthereumRpcClient();
  return ethereumFactsOf({
    blockOf: async (hash) =>
      (await topUpRpc.getTransaction(hash))?.blockNumber ?? null,
    topUpsIn: (block) =>
      getAllSubscriptionTopUps(getAlchemyInstance(network), block, block),
    logsOf: async (hash) =>
      (await mintRpc.getTransactionReceipt(hash))?.logs ?? null
  });
}
