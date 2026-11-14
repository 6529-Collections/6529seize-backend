import {
  NFT_OWNERS_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { LedgerRow, OwnerRow } from './state-audit.manifest';

const WALLET_BATCH = 250;
const READ_ONLY = { forcePool: DbPoolName.READ };

export type RawLedgerRow = {
  transaction: string;
  block: number | string;
  from_address: string;
  to_address: string;
  contract: string;
  token_id: number | string;
  token_count: number | string | null;
};

type RawOwnerRow = {
  wallet: string;
  contract: string;
  token_id: number | string;
  balance: number | string;
  block_reference: number | string;
};

export function normalizeLedgerRow(row: RawLedgerRow): LedgerRow {
  return {
    transaction: row.transaction.toLowerCase(),
    block: Number(row.block),
    from_address: row.from_address.toLowerCase(),
    to_address: row.to_address.toLowerCase(),
    contract: row.contract.toLowerCase(),
    token_id: BigInt(row.token_id).toString(),
    token_count: row.token_count == null ? 0 : Number(row.token_count)
  };
}

function normalizeOwnerRow(row: RawOwnerRow): OwnerRow {
  return {
    wallet: row.wallet.toLowerCase(),
    contract: row.contract.toLowerCase(),
    token_id: BigInt(row.token_id).toString(),
    balance: Number(row.balance),
    block_reference: Number(row.block_reference)
  };
}

export function compareLedgerRows(a: LedgerRow, b: LedgerRow): number {
  return (
    a.block - b.block ||
    a.transaction.localeCompare(b.transaction) ||
    a.from_address.localeCompare(b.from_address) ||
    a.to_address.localeCompare(b.to_address) ||
    a.token_id.localeCompare(b.token_id)
  );
}

function compareOwnerRows(a: OwnerRow, b: OwnerRow): number {
  return (
    a.wallet.localeCompare(b.wallet) || a.token_id.localeCompare(b.token_id)
  );
}

/**
 * Every statement here is a SELECT on the read pool. The class exposes no
 * write method, so the audit is read-only by construction.
 */
export class StateAuditDb extends LazyDbAccessCompatibleService {
  /** Before-image of the ledger rows inside the audited window. */
  async readLedgerRows(
    contract: string,
    fromBlock: number,
    toBlock: number
  ): Promise<LedgerRow[]> {
    const rows = await this.db.execute<RawLedgerRow>(
      `SELECT transaction, block, from_address, to_address, contract, token_id, token_count
       FROM ${TRANSACTIONS_TABLE}
       WHERE contract = :contract AND block >= :fromBlock AND block <= :toBlock`,
      { contract, fromBlock, toBlock },
      READ_ONLY
    );
    return rows.map(normalizeLedgerRow).sort(compareLedgerRows);
  }

  /**
   * Ledger history the owners consumer replays for a wallet: everything up to
   * `toBlock` where the wallet is an endpoint, except zero-address debits.
   */
  async readLedgerHistoryForWallets(
    contract: string,
    wallets: string[],
    toBlock: number
  ): Promise<LedgerRow[]> {
    const result: LedgerRow[] = [];
    for (let offset = 0; offset < wallets.length; offset += WALLET_BATCH) {
      const rows = await this.db.execute<RawLedgerRow>( // NOSONAR -- sequential batches bound memory and read-replica load.
        `SELECT transaction, block, from_address, to_address, contract, token_id, token_count
         FROM ${TRANSACTIONS_TABLE}
         WHERE contract = :contract AND block <= :toBlock
         AND ((from_address IN (:wallets) AND from_address <> :nullAddress)
              OR to_address IN (:wallets))`,
        {
          contract,
          toBlock,
          wallets: wallets.slice(offset, offset + WALLET_BATCH),
          nullAddress: NULL_ADDRESS.toLowerCase()
        },
        READ_ONLY
      );
      rows.forEach((row) => result.push(normalizeLedgerRow(row)));
    }
    return result.sort(compareLedgerRows);
  }

  /** The block the owners consumer last published for this contract. */
  async readOwnersBlockReference(contract: string): Promise<number | null> {
    const rows = await this.db.execute<{ block_reference: number | null }>(
      `SELECT MAX(block_reference) AS block_reference
       FROM ${NFT_OWNERS_TABLE} WHERE contract = :contract`,
      { contract },
      READ_ONLY
    );
    const value = rows[0]?.block_reference;
    return value == null ? null : Number(value);
  }

  async readOwnerRows(
    contract: string,
    wallets: string[]
  ): Promise<OwnerRow[]> {
    const result: OwnerRow[] = [];
    for (let offset = 0; offset < wallets.length; offset += WALLET_BATCH) {
      const rows = await this.db.execute<RawOwnerRow>( // NOSONAR -- sequential batches bound memory and read-replica load.
        `SELECT wallet, contract, token_id, balance, block_reference
         FROM ${NFT_OWNERS_TABLE}
         WHERE contract = :contract AND wallet IN (:wallets)`,
        { contract, wallets: wallets.slice(offset, offset + WALLET_BATCH) },
        READ_ONLY
      );
      rows.forEach((row) => result.push(normalizeOwnerRow(row)));
    }
    return result.sort(compareOwnerRows);
  }
}

export const stateAuditDb = new StateAuditDb(dbSupplier);
