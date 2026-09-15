import type { JsonRpcProvider } from 'ethers';
import type { MarketFee } from '@/marketplace/provider.types';

export interface MarketReceiptTransaction {
  purpose: 'APPROVAL' | 'TRANSACTION';
  from: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  /** Canonical inclusion time, Unix seconds; not the time the wallet was opened. */
  blockTimestamp: number;
  status: 'SUCCESS' | 'REVERTED';
  confirmation: 'INCLUDED' | 'CONFIRMED';
  safeBlockNumber?: number;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
  networkFeeWei?: string;
}

export interface MarketReceiptPayment {
  currency: string;
  totalWei: string;
  netWei: string;
  fees: MarketFee[];
  payoutWallet?: string;
}

export interface MarketReceipt {
  /** Only recorded transactions. Historical approvals may not be available. */
  transactions: MarketReceiptTransaction[];
  /** Only exact successful fulfillment proven in a safe canonical block. */
  payment?: MarketReceiptPayment;
}

interface ReceiptCosts {
  hash: string;
  blockNumber: number;
  blockHash: string;
  status: number | null;
  gasUsed?: bigint;
  gasPrice?: bigint;
}

/** Supplemental evidence must never prevent a validated transaction settling. */
export function marketReceiptTransaction(
  receipt: ReceiptCosts,
  blockTimestamp: number,
  from: string,
  purpose: MarketReceiptTransaction['purpose'],
  safeBlockNumber?: number
): MarketReceiptTransaction | undefined {
  if (
    !Number.isSafeInteger(blockTimestamp) ||
    blockTimestamp <= 0 ||
    ![0, 1].includes(receipt.status ?? -1)
  )
    return undefined;
  const confirmed =
    safeBlockNumber !== undefined && safeBlockNumber >= receipt.blockNumber;
  const gasKnown =
    typeof receipt.gasUsed === 'bigint' &&
    receipt.gasUsed > BigInt(0) &&
    typeof receipt.gasPrice === 'bigint' &&
    receipt.gasPrice >= BigInt(0);
  return {
    purpose,
    from: from.toLowerCase(),
    transactionHash: receipt.hash.toLowerCase(),
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    blockTimestamp,
    status: receipt.status === 1 ? 'SUCCESS' : 'REVERTED',
    confirmation: confirmed ? 'CONFIRMED' : 'INCLUDED',
    ...(confirmed ? { safeBlockNumber } : {}),
    ...(gasKnown
      ? {
          gasUsed: receipt.gasUsed!.toString(),
          effectiveGasPriceWei: receipt.gasPrice!.toString(),
          networkFeeWei: (receipt.gasUsed! * receipt.gasPrice!).toString()
        }
      : {})
  };
}

export function appendMarketReceiptTransaction(
  previous: readonly MarketReceiptTransaction[] | undefined,
  transaction: MarketReceiptTransaction | undefined
): MarketReceiptTransaction[] {
  if (!transaction) return [...(previous ?? [])];
  return [
    ...(previous ?? []).filter(
      (entry) => entry.transactionHash !== transaction.transactionHash
    ),
    transaction
  ];
}

/** These optional reads have a shared deadline; they never change send authority. */
export async function marketReceiptRead<T>(
  read: () => Promise<T>,
  deadline: number
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Receipt enrichment timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Receipt enrichment timed out')),
          remaining
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Approval recovery may proceed at inclusion. Only safe canonical approvals
 * enter recorded cost; temporary unavailability retains earlier confirmed proof. */
export async function confirmedMarketApprovalReceipts(
  entries: readonly MarketReceiptTransaction[] | undefined,
  rpc: Pick<JsonRpcProvider, 'getBlock'>,
  safe: { number: number; hash: string | null } | null
): Promise<MarketReceiptTransaction[]> {
  if (!entries?.length) return [];
  const contradicted = new Set<string>();
  const priorConfirmed = () =>
    entries.filter(
      (entry) =>
        entry.purpose === 'APPROVAL' &&
        entry.confirmation === 'CONFIRMED' &&
        !contradicted.has(entry.transactionHash)
    );
  if (!safe?.hash) return priorConfirmed();
  const confirmed: MarketReceiptTransaction[] = [];
  const deadline = Date.now() + 2000;
  try {
    for (const entry of entries) {
      if (entry.purpose !== 'APPROVAL' || entry.blockNumber > safe.number)
        continue;
      const block = await marketReceiptRead(
        () => rpc.getBlock(entry.blockNumber),
        deadline
      );
      if (block?.hash?.toLowerCase() === entry.blockHash.toLowerCase())
        confirmed.push({
          ...entry,
          confirmation: 'CONFIRMED',
          safeBlockNumber: entry.safeBlockNumber ?? safe.number
        });
      else if (block?.hash) contradicted.add(entry.transactionHash);
    }
    const canonical = await marketReceiptRead(
      () => rpc.getBlock(safe.number),
      deadline
    );
    if (canonical?.hash !== safe.hash) return priorConfirmed();
    return priorConfirmed().reduce(
      (result, entry) =>
        result.some(
          (current) => current.transactionHash === entry.transactionHash
        )
          ? result
          : [...result, entry],
      confirmed
    );
  } catch {
    return priorConfirmed();
  }
}
