import { isAddress } from 'ethers';
import { NULL_ADDRESS } from '@/constants';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';

export function repairWallets(event: unknown): string[] | null {
  if (
    !event ||
    typeof event !== 'object' ||
    !Object.prototype.hasOwnProperty.call(event, 'action')
  )
    return null;
  const input = event as { action: unknown; wallets?: unknown };
  if (
    input.action !== 'repair-wallets' ||
    !Array.isArray(input.wallets) ||
    input.wallets.length < 1 ||
    input.wallets.length > 100 ||
    input.wallets.some(
      (wallet) =>
        typeof wallet !== 'string' ||
        !isAddress(wallet) ||
        wallet.toLowerCase() === NULL_ADDRESS.toLowerCase()
    )
  ) {
    throw new Error(
      'Expected repair-wallets with 1–100 nonzero Ethereum wallet addresses'
    );
  }
  return Array.from(
    new Set((input.wallets as string[]).map((wallet) => wallet.toLowerCase()))
  );
}

export async function enqueueWalletRepair(wallets: string[]) {
  await transferReconciliationDb.enqueueRepair(wallets);
  return { action: 'repair-wallets', status: 'queued', wallets };
}
