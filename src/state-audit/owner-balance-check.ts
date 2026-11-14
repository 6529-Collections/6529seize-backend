import { NULL_ADDRESS } from '@/constants';
import type { ChainTransfer } from './chain-transfers';
import type { Discrepancy, LedgerRow, OwnerRow } from './state-audit.manifest';

/** Wallets the derived check will replay in one run; more is reported, not read. */
export const MAX_OWNER_CHECK_WALLETS = 250;

export const OWNER_CHECK_ASSUMPTIONS = [
  'Ledger rows outside the audited window are assumed correct; only in-window rows are replaced by chain edges.',
  'Balances follow the owners consumer: recipients are credited, senders debited, and the zero address is never debited.',
  'nft_owners is compared at its current MAX(block_reference) for the contract, which must be at or above the window end.',
  'The zero address is excluded; its nft_owners rows depend only on incoming burns and are rebuilt with the counterpart wallet.',
  'Rows with a non-positive expected balance are expected to be absent from nft_owners.'
];

interface BalanceEdge {
  from_address: string;
  to_address: string;
  token_id: string;
  token_count: number;
  block: number;
}

function balanceKey(wallet: string, tokenId: string): string {
  return `${wallet}:${tokenId}`;
}

function applyEdge(
  balances: Map<string, number>,
  wallets: Set<string>,
  edge: BalanceEdge
): void {
  const zero = NULL_ADDRESS.toLowerCase();
  if (edge.from_address !== zero && wallets.has(edge.from_address)) {
    const key = balanceKey(edge.from_address, edge.token_id);
    balances.set(key, (balances.get(key) ?? 0) - edge.token_count);
  }
  if (wallets.has(edge.to_address)) {
    const key = balanceKey(edge.to_address, edge.token_id);
    balances.set(key, (balances.get(key) ?? 0) + edge.token_count);
  }
}

/**
 * Expected per-wallet balances at `blockReference`: stored history outside the
 * window plus chain edges inside it, replayed with the owners consumer's rules.
 */
export function expectedBalances(args: {
  wallets: string[];
  history: LedgerRow[];
  chain: ChainTransfer[];
  fromBlock: number;
  toBlock: number;
  blockReference: number;
}): Map<string, number> {
  const wallets = new Set(args.wallets);
  const balances = new Map<string, number>();
  args.history
    .filter(
      (row) =>
        row.block <= args.blockReference &&
        (row.block < args.fromBlock || row.block > args.toBlock)
    )
    .forEach((row) => applyEdge(balances, wallets, row));
  args.chain
    .filter((transfer) => transfer.block <= args.blockReference)
    .forEach((transfer) =>
      applyEdge(balances, wallets, {
        from_address: transfer.from_address,
        to_address: transfer.to_address,
        token_id: transfer.token_id,
        token_count: Number(transfer.amount),
        block: transfer.block
      })
    );
  return balances;
}

function parseBalanceKey(key: string): { wallet: string; token_id: string } {
  const separator = key.indexOf(':');
  return {
    wallet: key.slice(0, separator),
    token_id: key.slice(separator + 1)
  };
}

export function compareOwnerBalances(
  contract: string,
  expected: Map<string, number>,
  stored: OwnerRow[]
): Discrepancy[] {
  const storedByKey = new Map<string, OwnerRow>();
  stored.forEach((row) =>
    storedByKey.set(balanceKey(row.wallet, row.token_id), row)
  );
  const keys = Array.from(
    new Set(Array.from(expected.keys()).concat(Array.from(storedByKey.keys())))
  ).sort((a, b) => a.localeCompare(b));
  const discrepancies: Discrepancy[] = [];
  keys.forEach((key) => {
    const expectedBalance = Math.max(expected.get(key) ?? 0, 0);
    const storedRow = storedByKey.get(key) ?? null;
    const storedBalance = storedRow?.balance ?? 0;
    if (expectedBalance === storedBalance) return;
    const { wallet, token_id } = parseBalanceKey(key);
    discrepancies.push({
      type: 'owner_balance_mismatch',
      wallet,
      token_id,
      stored_row: storedRow,
      expected_row: { wallet, contract, token_id, balance: expectedBalance }
    });
  });
  return discrepancies;
}
